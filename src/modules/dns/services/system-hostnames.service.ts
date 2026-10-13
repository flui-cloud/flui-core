import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { DnsProviderFactory } from '../../providers/core/factories/dns-provider.factory';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { DnsZoneEntity } from '../entities/dns-zone.entity';
import {
  CheckSystemHostnamesDto,
  SystemHostnameDto,
  SystemHostnamesResponseDto,
} from '../dto/system-hostnames.dto';
import {
  DEFAULT_SYSTEM_LABELS,
  SystemHostnameApp,
  hostnameProblem,
  labelUnderZone,
  normalizeHostnameInput,
  wildcardLabelProblem,
} from '../utils/system-hostnames.util';
import { resolveRecordName } from '../utils/resolve-record-name.util';
import { clusterIngressValues } from '../utils/ingress-addresses.core';
import { ClusterDnsZoneService } from './cluster-dns-zone.service';
import { EndpointHostGuardService } from './endpoint-host-guard.service';

export const SYSTEM_HOSTNAME_INVALID = 'system_hostname_invalid';
export const SYSTEM_HOSTNAME_TAKEN = 'system_hostname_taken';
export const SYSTEM_HOSTNAME_UNVERIFIED = 'system_hostname_unverified';

const STATUS_KEY: Record<SystemHostnameApp, 'fluiWeb' | 'fluiApi' | 'zitadel'> =
  {
    'flui-web': 'fluiWeb',
    'flui-api': 'fluiApi',
    zitadel: 'zitadel',
  };

const CLAIMING_RECORD_TYPES = new Set<DnsRecordType>([
  DnsRecordType.A,
  DnsRecordType.AAAA,
  DnsRecordType.CNAME,
]);

interface ResolvedChoice {
  app: SystemHostnameApp;
  label: string | null;
  fqdn: string;
}

/**
 * The public addresses of the platform's own applications: which name each
 * one gets by default, and whether a name someone chose may be used. The
 * endpoints themselves are created through the ordinary endpoint path, and the
 * dashboard, API and sign-in configuration follow those endpoints.
 */
@Injectable()
export class SystemHostnamesService {
  private readonly logger = new Logger(SystemHostnamesService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly endpoints: Repository<AppEndpointEntity>,
    @InjectRepository(DnsZoneEntity)
    private readonly dnsZones: Repository<DnsZoneEntity>,
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
    private readonly hostGuard: EndpointHostGuardService,
    private readonly dnsProviderFactory: DnsProviderFactory,
  ) {}

  async describe(
    clusterId: string,
    dnsZoneId?: string,
  ): Promise<SystemHostnamesResponseDto> {
    await this.requireCluster(clusterId);
    const zone = await this.resolveZone(clusterId, dnsZoneId);
    const status =
      await this.clusterDnsZoneService.getSystemDnsStatus(clusterId);

    const hostnames: SystemHostnameDto[] = [];
    for (const app of Object.keys(STATUS_KEY) as SystemHostnameApp[]) {
      const entry = status[STATUS_KEY[app]];
      if (!entry?.applicationId) continue;
      const currentFqdn = entry.domain ?? null;
      const defaultLabel = DEFAULT_SYSTEM_LABELS[app];
      const label = zone
        ? (labelUnderZone(currentFqdn, zone.zoneName) ?? defaultLabel)
        : defaultLabel;
      hostnames.push({
        app,
        applicationId: entry.applicationId,
        defaultLabel,
        label,
        fqdn: zone ? `${label}.${zone.zoneName}` : null,
        currentFqdn,
      });
    }
    return { zoneName: zone?.zoneName ?? null, hostnames };
  }

  async check(
    clusterId: string,
    dto: CheckSystemHostnamesDto,
  ): Promise<SystemHostnamesResponseDto> {
    const cluster = await this.requireCluster(clusterId);
    const needsZone = dto.hostnames.some((h) => h.label !== undefined);
    const zone = needsZone
      ? await this.resolveZone(clusterId, dto.dnsZoneId)
      : null;
    if (needsZone && !zone) {
      throw new BadRequestException({
        statusCode: 400,
        code: SYSTEM_HOSTNAME_INVALID,
        message: 'Choose a domain before choosing names under it.',
      });
    }

    const choices = this.resolveChoices(dto, zone);

    const hostnames: SystemHostnameDto[] = [];
    for (const choice of choices) {
      const application = await this.applications.findOne({
        where: { clusterId, slug: choice.app },
      });
      if (!application) {
        throw this.invalid(
          choice.app,
          `${choice.app} is not installed on this cluster.`,
        );
      }
      const ownsName = await this.assertNotUsedByAnotherEndpoint(
        choice,
        application,
      );
      await this.assertNotServedElsewhere(cluster, application, choice);
      if (zone && !ownsName) {
        await this.assertDnsNameFree(cluster, zone, choice);
      }
      const current = await this.endpoints.findOne({
        where: { applicationId: application.id },
      });
      hostnames.push({
        app: choice.app,
        applicationId: application.id,
        defaultLabel: DEFAULT_SYSTEM_LABELS[choice.app],
        label: choice.label,
        fqdn: choice.fqdn,
        currentFqdn: current?.fqdn ?? null,
      });
    }

    return { zoneName: zone?.zoneName ?? null, hostnames };
  }

  private resolveChoices(
    dto: CheckSystemHostnamesDto,
    zone: DnsZoneEntity | null,
  ): ResolvedChoice[] {
    const seenApps = new Set<SystemHostnameApp>();
    const byFqdn = new Map<string, SystemHostnameApp>();
    return dto.hostnames.map((choice) => {
      if (seenApps.has(choice.app)) {
        throw this.invalid(choice.app, `${choice.app} is listed twice.`);
      }
      seenApps.add(choice.app);

      const hasLabel = choice.label !== undefined;
      if (hasLabel === (choice.fqdn !== undefined)) {
        throw this.invalid(
          choice.app,
          'Give either a name under the domain or a full address.',
        );
      }

      let resolved: ResolvedChoice;
      if (hasLabel && zone) {
        const label = normalizeHostnameInput(choice.label);
        const problem = wildcardLabelProblem(label, zone.zoneName);
        if (problem) throw this.invalid(choice.app, problem);
        resolved = {
          app: choice.app,
          label,
          fqdn: `${label}.${zone.zoneName}`,
        };
      } else {
        const fqdn = normalizeHostnameInput(choice.fqdn);
        const problem = hostnameProblem(fqdn);
        if (problem) throw this.invalid(choice.app, problem);
        resolved = { app: choice.app, label: null, fqdn };
      }

      const twin = byFqdn.get(resolved.fqdn);
      if (twin) {
        throw this.invalid(
          choice.app,
          `${resolved.fqdn} is chosen for ${twin} too. Each address must be different.`,
        );
      }
      byFqdn.set(resolved.fqdn, resolved.app);
      return resolved;
    });
  }

  /** Returns whether the application already owns an endpoint on this name. */
  private async assertNotUsedByAnotherEndpoint(
    choice: ResolvedChoice,
    application: ApplicationEntity,
  ): Promise<boolean> {
    const holders = await this.endpoints.find({
      where: { fqdn: choice.fqdn },
      relations: ['application'],
    });
    const foreign = holders.find((e) => e.applicationId !== application.id);
    if (foreign) {
      throw this.taken(
        choice,
        `${choice.fqdn} is already used by ${foreign.application?.name ?? 'another application'}. Choose another name.`,
      );
    }
    return holders.length > 0;
  }

  private async assertNotServedElsewhere(
    cluster: ClusterEntity,
    application: ApplicationEntity,
    choice: ResolvedChoice,
  ): Promise<void> {
    try {
      await this.hostGuard.assertClaimable(
        cluster,
        application.k8sNamespace,
        choice.fqdn,
      );
    } catch (err) {
      if (err instanceof ConflictException) {
        throw this.taken(choice, this.messageOf(err));
      }
      throw err;
    }
  }

  /**
   * A name nobody on this installation uses can still be someone else's: the
   * same zone may serve another installation, and writing our record would
   * take its address away.
   */
  private async assertDnsNameFree(
    cluster: ClusterEntity,
    zone: DnsZoneEntity,
    choice: ResolvedChoice,
  ): Promise<void> {
    const provider = this.dnsProviderFactory.getDnsProvider(zone.dnsProvider);
    if (!provider) return;

    let records: Awaited<ReturnType<typeof provider.listRecords>>;
    try {
      records = await provider.listRecords(zone.providerZoneId);
    } catch (err) {
      this.logger.warn(
        `Could not list records of ${zone.zoneName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: SYSTEM_HOSTNAME_UNVERIFIED,
        field: choice.app,
        message: `Could not read the records of ${zone.zoneName} to check that ${choice.fqdn} is free. Try again.`,
      });
    }

    const name = resolveRecordName(choice.fqdn, zone.zoneName);
    const ours = new Set(clusterIngressValues(cluster));
    const clash = records.find(
      (r) =>
        CLAIMING_RECORD_TYPES.has(r.type) &&
        this.sameRecordName(r.name, name, choice.fqdn) &&
        !ours.has(r.value),
    );
    if (clash) {
      throw this.taken(
        choice,
        `${choice.fqdn} already points to ${clash.value}, probably another installation or service. Choose another name.`,
      );
    }
  }

  private sameRecordName(
    recordName: string,
    relative: string,
    fqdn: string,
  ): boolean {
    const n = normalizeHostnameInput(recordName);
    return n === relative || n === fqdn;
  }

  private async resolveZone(
    clusterId: string,
    dnsZoneId?: string,
  ): Promise<DnsZoneEntity | null> {
    if (dnsZoneId) {
      const zone = await this.dnsZones.findOne({ where: { id: dnsZoneId } });
      if (!zone) throw new NotFoundException(`DNS zone ${dnsZoneId} not found`);
      return zone;
    }
    const assignment =
      await this.clusterDnsZoneService.getZoneAssignment(clusterId);
    return assignment?.dnsZone ?? null;
  }

  private async requireCluster(clusterId: string): Promise<ClusterEntity> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    return cluster;
  }

  private invalid(app: SystemHostnameApp, message: string) {
    return new BadRequestException({
      statusCode: 400,
      code: SYSTEM_HOSTNAME_INVALID,
      field: app,
      message,
    });
  }

  private taken(choice: ResolvedChoice, message: string) {
    return new ConflictException({
      statusCode: 409,
      code: SYSTEM_HOSTNAME_TAKEN,
      field: choice.app,
      fqdn: choice.fqdn,
      message,
    });
  }

  private messageOf(err: HttpException): string {
    const body = err.getResponse();
    if (typeof body === 'object' && body && 'message' in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return err.message;
  }
}
