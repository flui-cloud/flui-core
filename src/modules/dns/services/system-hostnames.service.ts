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
import { isIP } from 'node:net';
import * as ipaddr from 'ipaddr.js';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { DnsProviderFactory } from '../../providers/core/factories/dns-provider.factory';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { DnsZoneEntity } from '../entities/dns-zone.entity';
import {
  CheckSystemHostnamesDto,
  SystemHostnameChoiceDto,
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
import { findPlatformEndpoint } from '../utils/platform-endpoint.util';

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
  zone: DnsZoneEntity | null;
}

function normalizeRecordValue(type: DnsRecordType, value: string): string {
  const trimmed = value.trim();
  if (type === DnsRecordType.CNAME) {
    return trimmed.toLowerCase().replace(/\.$/, '');
  }
  return isIP(trimmed)
    ? ipaddr.parse(trimmed).toString()
    : trimmed.toLowerCase();
}

function zoneCovers(zoneName: string, fqdn: string): boolean {
  const zone = zoneName.toLowerCase();
  return fqdn === zone || fqdn.endsWith(`.${zone}`);
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

    const choices = await this.resolveChoices(clusterId, dto, zone);

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
      if (choice.zone && !ownsName) {
        await this.assertDnsNameFree(cluster, choice.zone, choice);
      }
      const current = await findPlatformEndpoint(
        this.endpoints,
        application.id,
      );
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

  private async resolveChoices(
    clusterId: string,
    dto: CheckSystemHostnamesDto,
    zone: DnsZoneEntity | null,
  ): Promise<ResolvedChoice[]> {
    const seenApps = new Set<SystemHostnameApp>();
    const byFqdn = new Map<string, SystemHostnameApp>();
    const resolvedChoices: ResolvedChoice[] = [];
    for (const choice of dto.hostnames) {
      if (seenApps.has(choice.app)) {
        throw this.invalid(choice.app, `${choice.app} is listed twice.`);
      }
      seenApps.add(choice.app);

      const resolved = await this.resolveChoice(clusterId, choice, zone);

      const twin = byFqdn.get(resolved.fqdn);
      if (twin) {
        throw this.invalid(
          choice.app,
          `${resolved.fqdn} is chosen for ${twin} too. Each address must be different.`,
        );
      }
      byFqdn.set(resolved.fqdn, resolved.app);
      resolvedChoices.push(resolved);
    }
    return resolvedChoices;
  }

  private async resolveChoice(
    clusterId: string,
    choice: SystemHostnameChoiceDto,
    zone: DnsZoneEntity | null,
  ): Promise<ResolvedChoice> {
    const hasLabel = choice.label !== undefined;
    if (hasLabel === (choice.fqdn !== undefined)) {
      throw this.invalid(
        choice.app,
        'Give either a name under the domain or a full address.',
      );
    }
    if (hasLabel && zone) return this.resolveLabelChoice(choice, zone);
    return this.resolveFqdnChoice(clusterId, choice);
  }

  private resolveLabelChoice(
    choice: SystemHostnameChoiceDto,
    zone: DnsZoneEntity,
  ): ResolvedChoice {
    const label = normalizeHostnameInput(choice.label);
    const problem = wildcardLabelProblem(label, zone.zoneName);
    if (problem) throw this.invalid(choice.app, problem);
    return {
      app: choice.app,
      label,
      fqdn: `${label}.${zone.zoneName}`,
      zone,
    };
  }

  private async resolveFqdnChoice(
    clusterId: string,
    choice: SystemHostnameChoiceDto,
  ): Promise<ResolvedChoice> {
    const fqdn = normalizeHostnameInput(choice.fqdn);
    const problem = hostnameProblem(fqdn);
    if (problem) throw this.invalid(choice.app, problem);
    const owner = await this.zoneForFqdn(clusterId, fqdn);
    const wildcardProblem =
      owner.zone && owner.wildcard
        ? this.wildcardFqdnProblem(fqdn, owner.zone.zoneName)
        : null;
    if (wildcardProblem) throw this.invalid(choice.app, wildcardProblem);
    return { app: choice.app, label: null, fqdn, zone: owner.zone };
  }

  /**
   * The zone whose records decide whether a full address is free: the
   * cluster's own zone covering it, or else any registered zone covering it.
   */
  private async zoneForFqdn(
    clusterId: string,
    fqdn: string,
  ): Promise<{ zone: DnsZoneEntity | null; wildcard: boolean }> {
    const assignment = await this.clusterDnsZoneService.getZoneForFqdn(
      clusterId,
      fqdn,
    );
    if (assignment?.dnsZone) {
      return {
        zone: assignment.dnsZone,
        wildcard: !!assignment.wildcardCertificate,
      };
    }
    const registered = await this.dnsZones.find();
    const zone =
      registered
        .filter((z) => zoneCovers(z.zoneName, fqdn))
        .sort((a, b) => b.zoneName.length - a.zoneName.length)[0] ?? null;
    return { zone, wildcard: false };
  }

  private wildcardFqdnProblem(fqdn: string, zoneName: string): string | null {
    const zone = zoneName.toLowerCase();
    if (fqdn === zone) {
      return `The certificate for *.${zone} covers the names under ${zone}, not ${zone} itself. Use a name such as dashboard.${zone}.`;
    }
    return wildcardLabelProblem(fqdn.slice(0, -(zone.length + 1)), zone);
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
    const claiming = records.filter(
      (r) =>
        CLAIMING_RECORD_TYPES.has(r.type) &&
        this.sameRecordName(r.name, name, choice.fqdn),
    );
    if (claiming.length === 0) return;

    const ours = new Set(
      clusterIngressValues(cluster).map((v) =>
        normalizeRecordValue(DnsRecordType.A, v),
      ),
    );
    if (ours.size === 0) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: SYSTEM_HOSTNAME_UNVERIFIED,
        field: choice.app,
        message: `Cannot tell whether ${choice.fqdn} is free: it already has a record, and this cluster's public address is not known yet to compare it with. Try again once the cluster reports its address.`,
      });
    }
    const clash = claiming.find(
      (r) => !ours.has(normalizeRecordValue(r.type, r.value)),
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
