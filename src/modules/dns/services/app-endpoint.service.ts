import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { In, QueryFailedError, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { SanCertificateEntity } from '../entities/san-certificate.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ClusterDnsZoneEntity } from '../entities/cluster-dns-zone.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { CreateAppEndpointDto } from '../dto/create-app-endpoint.dto';
import { UpdateAppEndpointDto } from '../dto/update-app-endpoint.dto';
import { AppEndpointResponseDto } from '../dto/app-endpoint-response.dto';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { ApplicationSourceType } from '../../applications/enums/application-source-type.enum';
import { ApplicationExposure } from '../../applications/enums/application-exposure.enum';
import { EndpointType } from '../enums/endpoint-type.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { ClusterDnsZoneService } from './cluster-dns-zone.service';
import { EndpointModeResolverService } from './endpoint-mode-resolver.service';
import { ClusterAuthzInstallRepository } from '../../authz/repositories/cluster-authz-install.repository';
import { internalHostingNotAvailableException } from '../constants/internal-hosting-error';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';

@Injectable()
export class AppEndpointService {
  private readonly logger = new Logger(AppEndpointService.name);

  constructor(
    @InjectRepository(AppEndpointEntity)
    private readonly endpointRepository: Repository<AppEndpointEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ClusterDnsZoneEntity)
    private readonly clusterDnsZoneRepository: Repository<ClusterDnsZoneEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applicationRepository: Repository<ApplicationEntity>,
    @InjectRepository(SanCertificateEntity)
    private readonly sanCertificateRepository: Repository<SanCertificateEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
    private readonly endpointModeResolver: EndpointModeResolverService,
    private readonly authzInstallRepo: ClusterAuthzInstallRepository,
  ) {}

  /**
   * Creates an `endpointType: INTERNAL` row for an `exposure=internal`
   * application. fqdn is derived (`<slug>.internal.<zoneName>`); the DNS
   * record is NOT per-app (the cluster-wide `*.internal.<zone>` wildcard
   * covers it); the certificate is emitted on-demand by cert-manager via
   * the wildcard DNS01 issuer at reconciliation time.
   *
   * Caller is responsible for triggering reconciliation
   * (`appEndpointReconciliationService.reconcile(endpoint.id)`) — keeping
   * that out of here avoids the circular dependency.
   */
  async createInternalEndpoint(
    application: ApplicationEntity,
  ): Promise<AppEndpointEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: application.clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${application.clusterId} not found`);
    }
    const status = await this.clusterDnsZoneService.getInternalHostingStatus(
      application.clusterId,
    );
    if (!status.ready) {
      throw new BadRequestException(
        `Cannot create internal endpoint: cluster ${application.clusterId} is not internal-ready (missing: ${status.missing.join(', ')})`,
      );
    }
    const assignment = await this.clusterDnsZoneService.getZoneAssignment(
      application.clusterId,
    );
    const wildcardIssuer =
      await this.clusterDnsZoneService.resolveWildcardIssuer(
        application.clusterId,
      );
    const fqdn = `${application.slug}.internal.${assignment.dnsZone.zoneName}`;
    const existing = await this.endpointRepository.findOne({
      where: {
        applicationId: application.id,
        endpointType: EndpointType.INTERNAL,
      },
    });
    if (existing) {
      this.logger.log(
        `Internal endpoint already exists for application ${application.id} (${fqdn}) — skipping create`,
      );
      return existing;
    }
    const endpoint = this.endpointRepository.create({
      clusterId: application.clusterId,
      applicationId: application.id,
      clusterDnsZoneId: assignment.id,
      endpointType: EndpointType.INTERNAL,
      fqdn,
      // Override entity default (IP) — internal FQDNs are under the cluster zone, not nip.io.
      hostnameMode: HostnameMode.DOMAIN,
      serviceName: application.name,
      k8sServiceName:
        application.sourceType === ApplicationSourceType.RAW_MANIFEST
          ? application.slug
          : `${application.slug}-svc`,
      k8sNamespace: application.k8sNamespace,
      k8sServicePort: await this.resolveServicePort(cluster, application),
      dnsRecordType: DnsRecordType.A,
      certificateProvider:
        wildcardIssuer?.certificateProvider ?? CertificateProvider.LETS_ENCRYPT,
      certificateRequired: true,
      reconciliationStatus: ReconciliationStatus.PENDING,
    });
    return this.endpointRepository.save(endpoint);
  }

  async createEndpoint(
    clusterId: string,
    dto: CreateAppEndpointDto,
  ): Promise<AppEndpointEntity> {
    this.logger.log(
      `Creating endpoint for application ${dto.applicationId} on cluster ${clusterId}`,
    );

    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const application = await this.applicationRepository.findOne({
      where: { id: dto.applicationId },
    });
    if (!application) {
      throw new NotFoundException(`Application ${dto.applicationId} not found`);
    }
    if (application.clusterId !== clusterId) {
      throw new BadRequestException(
        `Application ${dto.applicationId} does not belong to cluster ${clusterId}`,
      );
    }

    // Endpoint type resolution: explicit dto.endpointType wins; otherwise
    // fall back to the application's exposure (back-compat).
    const requestedType =
      dto.endpointType ??
      (application.exposure === ApplicationExposure.INTERNAL
        ? EndpointType.INTERNAL
        : EndpointType.PUBLIC);

    if (requestedType === EndpointType.INTERNAL) {
      // Gate 1: cluster must support internal hosting (DNS zone + wildcard issuer).
      const status =
        await this.clusterDnsZoneService.getInternalHostingStatus(clusterId);
      if (!status.ready) {
        throw internalHostingNotAvailableException(clusterId, status.missing);
      }
      // Gate 2: Auth Proxy must be RUNNING — otherwise an "internal" endpoint
      // would not actually be gated and exposes a private app to the internet.
      const authzInstall =
        await this.authzInstallRepo.findRunningForCluster(clusterId);
      if (!authzInstall) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'AUTH_PROXY_NOT_RUNNING',
          message: `Cluster ${clusterId} has no running Auth Proxy install. Internal endpoints require the Flui Auth Proxy to be installed and running on the cluster. Install it from /infrastructure/auth-proxy and try again.`,
          clusterId,
        });
      }
      // Reuse the canonical internal-endpoint creator (same logic as the
      // initial app-creation path), so the DTO route and the implicit route
      // produce identical rows.
      return this.createInternalEndpoint(application);
    }

    const endpointType = EndpointType.PUBLIC;

    let clusterDnsZone: ClusterDnsZoneEntity | null = null;
    if (dto.clusterDnsZoneId) {
      clusterDnsZone = await this.clusterDnsZoneRepository.findOne({
        where: { id: dto.clusterDnsZoneId },
        relations: ['dnsZone'],
      });
      if (!clusterDnsZone) {
        throw new NotFoundException(
          `Cluster DNS zone ${dto.clusterDnsZoneId} not found`,
        );
      }
    }

    const resolved = this.endpointModeResolver.resolve({
      cluster,
      clusterDnsZone,
      wildcardEnabled: !!clusterDnsZone?.wildcardCertificate,
      requestedFqdn: dto.fqdn,
      requestedCertChallenge: dto.certChallenge,
      requestedHostnameMode: dto.hostnameMode,
      slug: application.slug ?? application.name,
    });
    const fqdn = this.normalizeFqdn(resolved.fqdn);

    if (await this.isFqdnTaken(fqdn)) {
      throw new ConflictException({
        statusCode: 409,
        error: 'endpoint_fqdn_conflict',
        message: 'Domain is already in use',
        fqdn,
      });
    }

    const sanCertificateId = dto.sanCertificateId
      ? await this.resolveSanCertificateId(
          dto.sanCertificateId,
          clusterId,
          fqdn,
        )
      : null;

    const endpoint = this.endpointRepository.create({
      clusterId,
      applicationId: application.id,
      clusterDnsZoneId: dto.clusterDnsZoneId ?? null,
      endpointType,
      fqdn,
      serviceName: application.name,
      // System apps (RAW_MANIFEST) already have a K8s Service named after their slug.
      // User apps follow the ${slug}-svc convention created by the manifest generator.
      k8sServiceName:
        application.sourceType === ApplicationSourceType.RAW_MANIFEST
          ? application.slug
          : `${application.slug}-svc`,
      k8sNamespace: application.k8sNamespace,
      k8sServicePort: await this.resolveServicePort(cluster, application),
      dnsRecordType: DnsRecordType.A,
      certificateProvider: dto.certificateProvider ?? null,
      certificateRequired: dto.certificateRequired ?? true,
      certChallenge: resolved.certChallenge,
      hostnameMode: resolved.hostnameMode,
      sanCertificateId,
      reconciliationStatus: ReconciliationStatus.PENDING,
    });

    try {
      return await this.endpointRepository.save(endpoint);
    } catch (err) {
      if (this.isUniqueFqdnViolation(err)) {
        throw new ConflictException({
          statusCode: 409,
          error: 'endpoint_fqdn_conflict',
          message: 'Domain is already in use',
          fqdn,
        });
      }
      throw err;
    }
  }

  private async resolveSanCertificateId(
    sanCertificateId: string,
    clusterId: string,
    fqdn: string,
  ): Promise<string> {
    const san = await this.sanCertificateRepository.findOne({
      where: { id: sanCertificateId },
    });
    if (!san) {
      throw new NotFoundException(
        `SAN certificate ${sanCertificateId} not found`,
      );
    }
    if (san.clusterId !== clusterId) {
      throw new BadRequestException(
        `SAN certificate ${sanCertificateId} belongs to a different cluster`,
      );
    }
    if (!san.dnsNames.includes(fqdn)) {
      throw new BadRequestException(
        `fqdn "${fqdn}" is not part of SAN certificate ${sanCertificateId} (dnsNames: ${san.dnsNames.join(', ')})`,
      );
    }
    return san.id;
  }

  normalizeFqdn(fqdn: string): string {
    return fqdn.trim().toLowerCase();
  }

  async isFqdnAvailable(fqdn: string): Promise<boolean> {
    return !(await this.isFqdnTaken(this.normalizeFqdn(fqdn)));
  }

  private async isFqdnTaken(fqdn: string): Promise<boolean> {
    const existing = await this.endpointRepository.findOne({
      where: { fqdn },
      select: ['id'],
    });
    return !!existing;
  }

  private isUniqueFqdnViolation(err: unknown): boolean {
    if (!(err instanceof QueryFailedError)) return false;
    const driverError = (
      err as QueryFailedError & {
        driverError?: { code?: string; constraint?: string };
      }
    ).driverError;
    return driverError?.code === '23505';
  }

  async listEndpoints(clusterId: string): Promise<AppEndpointEntity[]> {
    return await this.endpointRepository.find({
      where: { clusterId },
      relations: ['clusterDnsZone', 'clusterDnsZone.dnsZone'],
    });
  }

  async listByApplicationId(
    applicationId: string,
  ): Promise<AppEndpointEntity[]> {
    return await this.endpointRepository.find({
      where: { applicationId },
      relations: ['cluster', 'clusterDnsZone', 'clusterDnsZone.dnsZone'],
    });
  }

  /**
   * Of the given candidate hostnames, return those that are real app endpoint fqdns —
   * the source of truth used to tell a genuine app URL from a model-fabricated one.
   */
  async existingFqdns(hosts: string[]): Promise<string[]> {
    if (hosts.length === 0) return [];
    const rows = await this.endpointRepository.find({
      where: { fqdn: In(hosts) },
      select: ['fqdn'],
    });
    return rows.map((r) => r.fqdn);
  }

  /**
   * Resolve the primary endpoint hostname of several applications in one query —
   * used to attach the real public URL to app listings without an N+1 lookup. Maps
   * each applicationId to its first endpoint fqdn; ids with no endpoint are absent.
   */
  async mapPrimaryFqdns(
    applicationIds: string[],
  ): Promise<Map<string, string>> {
    if (applicationIds.length === 0) return new Map();
    const endpoints = await this.endpointRepository.find({
      where: { applicationId: In(applicationIds) },
    });
    const byApp = new Map<string, string>();
    for (const endpoint of endpoints) {
      if (endpoint.fqdn && !byApp.has(endpoint.applicationId)) {
        byApp.set(endpoint.applicationId, endpoint.fqdn);
      }
    }
    return byApp;
  }

  async getEndpoint(id: string): Promise<AppEndpointEntity> {
    const endpoint = await this.endpointRepository.findOne({
      where: { id },
      relations: ['cluster', 'clusterDnsZone', 'clusterDnsZone.dnsZone'],
    });

    if (!endpoint) {
      throw new NotFoundException(`App endpoint ${id} not found`);
    }

    return endpoint;
  }

  async updateEndpoint(
    id: string,
    dto: UpdateAppEndpointDto,
  ): Promise<AppEndpointEntity> {
    const endpoint = await this.getEndpoint(id);

    if (dto.fqdn !== undefined) endpoint.fqdn = dto.fqdn;
    if (dto.certificateRequired !== undefined)
      endpoint.certificateRequired = dto.certificateRequired;
    if (dto.certificateProvider !== undefined)
      endpoint.certificateProvider = dto.certificateProvider;
    if (dto.hostnameMode !== undefined) {
      endpoint.hostnameMode = dto.hostnameMode;
      endpoint.reconciliationStatus = ReconciliationStatus.DRIFT;
    }
    if (dto.certChallenge !== undefined) {
      endpoint.certChallenge = dto.certChallenge;
      endpoint.reconciliationStatus = ReconciliationStatus.DRIFT;
    }

    if (dto.clusterDnsZoneId !== undefined) {
      if (dto.clusterDnsZoneId === null) {
        endpoint.clusterDnsZoneId = null;
      } else {
        const zone = await this.clusterDnsZoneRepository.findOne({
          where: { id: dto.clusterDnsZoneId },
        });
        if (!zone) {
          throw new NotFoundException(
            `Cluster DNS zone ${dto.clusterDnsZoneId} not found`,
          );
        }
        endpoint.clusterDnsZoneId = dto.clusterDnsZoneId;
      }

      endpoint.reconciliationStatus = ReconciliationStatus.DRIFT;
    }

    return await this.endpointRepository.save(endpoint);
  }

  async deleteEndpoint(id: string): Promise<void> {
    const endpoint = await this.getEndpoint(id);
    await this.endpointRepository.remove(endpoint);
    this.logger.log(`Deleted app endpoint ${id} (${endpoint.fqdn})`);
  }

  async setWildcardBinding(
    id: string,
    wildcardCertificateId: string | null,
    tlsSecretName: string | null,
  ): Promise<void> {
    await this.endpointRepository.update(id, {
      wildcardCertificateId,
      tlsSecretName,
    });
  }

  async setSanBinding(
    id: string,
    sanCertificateId: string | null,
    tlsSecretName: string | null,
  ): Promise<void> {
    await this.endpointRepository.update(id, {
      sanCertificateId,
      tlsSecretName,
    });
  }

  async updateCertificateStatus(
    id: string,
    status: CertificateStatus,
    message: string | null,
  ): Promise<void> {
    await this.endpointRepository.update(id, {
      certificateStatus: status,
      certificateMessage: message,
    });
  }

  async updateReconciliationStatus(
    id: string,
    status: ReconciliationStatus,
    errorMessage?: string,
  ): Promise<AppEndpointEntity> {
    const endpoint = await this.getEndpoint(id);

    endpoint.reconciliationStatus = status;
    endpoint.errorMessage = errorMessage ?? null;

    if (
      status === ReconciliationStatus.IN_SYNC ||
      status === ReconciliationStatus.ERROR
    ) {
      endpoint.lastReconciliationAt = new Date();
    }

    return await this.endpointRepository.save(endpoint);
  }

  async markReconciliationComplete(
    id: string,
    dnsRecordId?: string,
    dnsRecordValue?: string,
    certificateStatus?: CertificateStatus,
    certificateMessage?: string,
    certificateExpiresAt?: Date,
  ): Promise<AppEndpointEntity> {
    const endpoint = await this.getEndpoint(id);

    endpoint.reconciliationStatus = ReconciliationStatus.IN_SYNC;
    endpoint.lastReconciliationAt = new Date();
    endpoint.errorMessage = null;

    if (dnsRecordId !== undefined) endpoint.dnsRecordId = dnsRecordId;
    if (dnsRecordValue !== undefined) endpoint.dnsRecordValue = dnsRecordValue;
    if (certificateStatus !== undefined)
      endpoint.certificateStatus = certificateStatus;
    if (certificateMessage !== undefined)
      endpoint.certificateMessage = certificateMessage;
    if (certificateExpiresAt !== undefined)
      endpoint.certificateExpiresAt = certificateExpiresAt;

    return await this.endpointRepository.save(endpoint);
  }

  toResponseDto(endpoint: AppEndpointEntity): AppEndpointResponseDto {
    return {
      id: endpoint.id,
      clusterId: endpoint.clusterId,
      applicationId: endpoint.applicationId,
      clusterDnsZoneId: endpoint.clusterDnsZoneId,
      endpointType: endpoint.endpointType ?? EndpointType.PUBLIC,
      hostnameMode: endpoint.hostnameMode,
      certChallenge: endpoint.certChallenge,
      fqdn: endpoint.fqdn,
      serviceName: endpoint.serviceName,
      k8sServiceName: endpoint.k8sServiceName,
      k8sNamespace: endpoint.k8sNamespace,
      k8sServicePort: endpoint.k8sServicePort,
      dnsRecordType: endpoint.dnsRecordType,
      dnsRecordValue: endpoint.dnsRecordValue,
      dnsRecordId: endpoint.dnsRecordId,
      certificateRequired: endpoint.certificateRequired,
      certificateProvider: endpoint.certificateProvider,
      tlsEnabled:
        endpoint.certificateRequired &&
        endpoint.certificateStatus === CertificateStatus.VALID,
      certificateStatus: endpoint.certificateStatus,
      certificateMessage: endpoint.certificateMessage,
      certificateExpiresAt: endpoint.certificateExpiresAt,
      reconciliationStatus: endpoint.reconciliationStatus,
      lastReconciliationAt: endpoint.lastReconciliationAt,
      errorMessage: endpoint.errorMessage,
      metadata: endpoint.metadata,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
    };
  }

  private async resolveServicePort(
    cluster: ClusterEntity,
    application: ApplicationEntity,
  ): Promise<number> {
    // Use the port stored on the application entity (set at creation time from user input or railpack).
    // The K8s Service is created asynchronously, so we cannot rely on it being present yet.
    if (application.port) {
      return application.port;
    }

    // Fallback: read from live K8s Service (for apps created before the port field was populated)
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster ${cluster.id} has no kubeconfig — cannot resolve service port`,
      );
    }

    const kubeconfig = this.kubernetesService.patchKubeconfigServer(
      this.encryptionService.decrypt(cluster.kubeconfigEncrypted),
    );
    const svcName = `${application.slug}-svc`;
    const svc = await this.kubernetesService.getResource(
      kubeconfig,
      'Service',
      svcName,
      application.k8sNamespace,
    );

    const port: number | undefined = svc?.spec?.ports?.[0]?.port;

    if (!port) {
      throw new BadRequestException(
        `Could not resolve port for application "${application.slug}": no port configured and K8s Service "${svcName}" not found or has no ports`,
      );
    }

    return port;
  }
}
