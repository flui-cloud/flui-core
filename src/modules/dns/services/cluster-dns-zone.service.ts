import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterDnsZoneEntity } from '../entities/cluster-dns-zone.entity';
import { DnsZoneEntity } from '../entities/dns-zone.entity';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { AssignDnsZoneDto } from '../dto/assign-dns-zone.dto';
import { ClusterDnsZoneResponseDto } from '../dto/cluster-dns-zone-response.dto';
import {
  SystemDnsStatusResponseDto,
  SystemAppDnsStatusDto,
} from '../dto/system-dns-status-response.dto';
import {
  CertificateStatus,
  Dns01Credential,
  Dns01SolverSpec,
} from '../../providers/interfaces/certificate-provider.interface';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { AcmeCertificateService } from '../../providers/services/acme-certificate.service';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { ICredentialProvider } from '../../providers/interfaces/credential-provider.interface';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { DnsProvider } from '../../providers/enums/dns-provider.enum';
import { ConfigureIssuerDto } from '../dto/configure-issuer.dto';
import { ClusterDnsGateway } from '../gateway/cluster-dns.gateway';
import { InternalHostingMissingRequirement } from '../constants/internal-hosting-error';
import {
  AcmeChallengeInfoDto,
  AcmeOrderInfoDto,
  CertDiagnosticsResponseDto,
  CertificateDiagnosticsDto,
  CertificateRequestInfoDto,
} from '../dto/cert-diagnostics-response.dto';

type SolverType = 'http01' | 'dns01' | 'combined' | null;

function isOrderOwnedByRequest(
  order: AcmeOrderInfoDto,
  rawOrders: Array<{ body?: any; metadata?: any; spec?: any; status?: any }>,
  certificateRequestName: string,
): boolean {
  const raw = rawOrders.find(
    (ro) => (ro.body ?? ro).metadata?.name === order.name,
  );
  if (!raw) return false;
  const ord = raw.body ?? raw;
  return (
    ord.metadata?.ownerReferences?.some(
      (ref: { name: string }) => ref.name === certificateRequestName,
    ) ?? false
  );
}

@Injectable()
export class ClusterDnsZoneService {
  private readonly logger = new Logger(ClusterDnsZoneService.name);
  private readonly httpIssuerNames = [
    'letsencrypt-staging',
    'letsencrypt-production',
  ];
  private readonly dnsIssuerNames = [
    'letsencrypt-staging-wildcard',
    'letsencrypt-production-wildcard',
  ];

  constructor(
    @InjectRepository(ClusterDnsZoneEntity)
    private readonly clusterDnsZoneRepository: Repository<ClusterDnsZoneEntity>,
    @InjectRepository(DnsZoneEntity)
    private readonly dnsZoneRepository: Repository<DnsZoneEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applicationRepository: Repository<ApplicationEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly appEndpointRepository: Repository<AppEndpointEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly acmeCertificateService: AcmeCertificateService,
    private readonly clusterDnsGateway: ClusterDnsGateway,
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
  ) {}

  /**
   * Predicate used by every internal-hosting gating point. A cluster is
   * "internal-ready" iff it has the same prerequisites as public hosting:
   * a DNS zone assigned and a Ready wildcard issuer in cert-manager.
   *
   * Rationale: internal endpoints reuse the public endpoint pipeline
   * (per-app A record + per-app cert via DNS01/HTTP01). The only internal-
   * specific piece is the Traefik Middleware ForwardAuth applied in front
   * of the Ingress — that requires no extra cluster-wide infrastructure,
   * just the backend's own public URL (read from PUBLIC_API_URL /
   * FLUI_API_ENDPOINT / API_BASE_URL, populated by ApiDomainSyncService)
   * which is checked at
   * reconcile time with a fail-closed policy.
   */
  async getInternalHostingStatus(clusterId: string): Promise<{
    ready: boolean;
    missing: InternalHostingMissingRequirement[];
    zoneName?: string;
  }> {
    const missing: InternalHostingMissingRequirement[] = [];
    const zones = await this.getZonesForCluster(clusterId);
    if (zones.length === 0) {
      missing.push('dns_zone');
      return { ready: false, missing };
    }
    const wildcardIssuer = await this.resolveWildcardIssuer(clusterId);
    if (!wildcardIssuer) missing.push('wildcard_issuer');
    return {
      ready: missing.length === 0,
      missing,
      zoneName: zones[0].dnsZone?.zoneName,
    };
  }

  async hasInternalHosting(clusterId: string): Promise<boolean> {
    return (await this.getInternalHostingStatus(clusterId)).ready;
  }

  async assignZoneToCluster(
    clusterId: string,
    dto: AssignDnsZoneDto,
  ): Promise<ClusterDnsZoneEntity> {
    this.logger.log(
      `Assigning DNS zone ${dto.dnsZoneId} to cluster ${clusterId}`,
    );

    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const dnsZone = await this.dnsZoneRepository.findOne({
      where: { id: dto.dnsZoneId },
    });
    if (!dnsZone) {
      throw new NotFoundException(`DNS zone ${dto.dnsZoneId} not found`);
    }

    const existing = await this.clusterDnsZoneRepository.findOne({
      where: { clusterId, dnsZoneId: dto.dnsZoneId },
    });

    if (existing) {
      throw new ConflictException(
        `DNS zone ${dto.dnsZoneId} is already assigned to cluster ${clusterId} (assignment ${existing.id}).`,
      );
    }

    const assignment = this.clusterDnsZoneRepository.create({
      clusterId,
      dnsZoneId: dto.dnsZoneId,
      certificateProvider: dto.certificateProvider ?? null,
      acmeEmail: dto.acmeEmail ?? null,
      wildcardCertificate: dto.wildcardCertificate ?? true,
      reconciliationStatus: ReconciliationStatus.PENDING,
    });

    const saved = await this.clusterDnsZoneRepository.save(assignment);
    await this.reconcileAssignment(saved.id);
    return saved;
  }

  /**
   * Brings one zone assignment to a truthful status, applying whatever cluster
   * state it needs on the way: the DNS-01 credential Secrets and the wildcard
   * ClusterIssuers, whose solver selectors must cover every assigned zone or
   * challenges for the non-primary ones fail with "no configured challenge
   * solvers".
   *
   * Every zone added after the initial issuer setup goes through here —
   * without it an assignment created as PENDING has no path out of PENDING,
   * since the issuer-configuration endpoints are the only other writers of
   * that column.
   */
  async reconcileAssignment(
    assignmentId: string,
  ): Promise<ClusterDnsZoneEntity> {
    const assignment = await this.getById(assignmentId);
    const clusterId = assignment.clusterId;

    await this.updateReconciliationStatus(
      assignmentId,
      ReconciliationStatus.RECONCILING,
    );

    try {
      await this.applyWildcardIssuersIfConfigured(clusterId);
      await this.refreshAssignmentStatuses(clusterId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Reconcile of DNS zone assignment ${assignmentId} failed: ${message}`,
      );
      await this.updateReconciliationStatus(
        assignmentId,
        ReconciliationStatus.ERROR,
        message,
      );
    }

    return await this.getById(assignmentId);
  }

  /**
   * Re-applies the wildcard ClusterIssuers so their dns01 solvers cover every
   * zone currently assigned to the cluster. No-op when no zone wants wildcard
   * TLS or when no ACME email is known yet — those clusters get the full
   * solver set when the issuers are first configured.
   */
  private async applyWildcardIssuersIfConfigured(
    clusterId: string,
  ): Promise<void> {
    const assignments = await this.getZonesForCluster(clusterId);
    if (!assignments.some((a) => a.wildcardCertificate)) return;

    const acmeEmail = await this.resolveAcmeEmail(clusterId);
    if (!acmeEmail) return;

    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);

    const kubeconfig = await this.getKubeconfig(cluster);
    await this.applyDnsCredentialSecrets(clusterId, kubeconfig);
    await this.applyDnsClusterIssuers(clusterId, kubeconfig, acmeEmail);
    this.watchIssuers(clusterId, kubeconfig, acmeEmail, [
      ...this.dnsIssuerNames,
    ]).catch((err) =>
      this.logger.error(
        `[${clusterId}] watchIssuers fatal error: ${err.message}`,
      ),
    );
  }

  /**
   * ACME email for the cluster: what the operator entered on any assignment
   * first, falling back to the email an existing ClusterIssuer already
   * registered with. Returns null when the cluster has never been given one.
   */
  private async resolveAcmeEmail(clusterId: string): Promise<string | null> {
    const assignments = await this.getZonesForCluster(clusterId);
    const fromAssignment = assignments.find((a) => a.acmeEmail)?.acmeEmail;
    if (fromAssignment) return fromAssignment;
    try {
      const issuers = await this.getIssuers(clusterId);
      return issuers.find((i) => i.email)?.email ?? null;
    } catch (err) {
      this.logger.warn(
        `Could not read issuers of cluster ${clusterId} for the ACME email: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async getZonesForCluster(clusterId: string): Promise<ClusterDnsZoneEntity[]> {
    return await this.clusterDnsZoneRepository.find({
      where: { clusterId },
      relations: ['dnsZone', 'cluster'],
      order: { createdAt: 'ASC' },
    });
  }

  // Returns the first zone assigned to the cluster, or null. Used by cluster-
  // wide setup paths (issuer config, internal hosting, DNS provider lookup)
  // where any zone is acceptable. For endpoint creation, use getZoneForFqdn.
  async getZoneAssignment(
    clusterId: string,
  ): Promise<ClusterDnsZoneEntity | null> {
    const zones = await this.getZonesForCluster(clusterId);
    return zones[0] ?? null;
  }

  async getZoneAssignmentOrFail(
    clusterId: string,
  ): Promise<ClusterDnsZoneEntity> {
    const assignment = await this.getZoneAssignment(clusterId);

    if (!assignment) {
      throw new NotFoundException(
        `No DNS zone assigned to cluster ${clusterId}`,
      );
    }

    return assignment;
  }

  // Resolves which assigned zone an FQDN belongs to via longest-suffix match.
  // Returns null if no assigned zone covers the FQDN (caller decides whether
  // that's BYOD or an error).
  async getZoneForFqdn(
    clusterId: string,
    fqdn: string,
  ): Promise<ClusterDnsZoneEntity | null> {
    if (!fqdn) return null;
    const zones = await this.getZonesForCluster(clusterId);
    const normalized = fqdn.toLowerCase();
    const matches = zones.filter((z) => {
      const zoneName = z.dnsZone?.zoneName?.toLowerCase();
      if (!zoneName) return false;
      return normalized === zoneName || normalized.endsWith(`.${zoneName}`);
    });
    if (matches.length === 0) return null;
    matches.sort(
      (a, b) =>
        (b.dnsZone?.zoneName?.length ?? 0) - (a.dnsZone?.zoneName?.length ?? 0),
    );
    return matches[0];
  }

  async getById(id: string): Promise<ClusterDnsZoneEntity> {
    const assignment = await this.clusterDnsZoneRepository.findOne({
      where: { id },
      relations: ['dnsZone', 'cluster'],
    });

    if (!assignment) {
      throw new NotFoundException(
        `Cluster DNS zone assignment ${id} not found`,
      );
    }

    return assignment;
  }

  async removeAssignment(assignmentId: string): Promise<void> {
    const assignment = await this.getById(assignmentId);
    await this.clusterDnsZoneRepository.remove(assignment);
    this.logger.log(
      `Removed DNS zone assignment ${assignmentId} from cluster ${assignment.clusterId}`,
    );
  }

  async removeZoneFromCluster(clusterId: string): Promise<void> {
    const assignments = await this.getZonesForCluster(clusterId);
    if (assignments.length === 0) {
      throw new NotFoundException(
        `No DNS zone assigned to cluster ${clusterId}`,
      );
    }
    await this.clusterDnsZoneRepository.remove(assignments);
    this.logger.log(
      `Removed ${assignments.length} DNS zone assignment(s) from cluster ${clusterId}`,
    );
  }

  async updateCertConfigById(
    assignmentId: string,
    dto: Partial<AssignDnsZoneDto>,
  ): Promise<ClusterDnsZoneEntity> {
    const assignment = await this.getById(assignmentId);
    return this.applyCertConfigUpdate(assignment, dto);
  }

  async updateCertConfig(
    clusterId: string,
    dto: Partial<AssignDnsZoneDto>,
  ): Promise<ClusterDnsZoneEntity> {
    const assignment = await this.getZoneAssignmentOrFail(clusterId);
    return this.applyCertConfigUpdate(assignment, dto);
  }

  private async applyCertConfigUpdate(
    assignment: ClusterDnsZoneEntity,
    dto: Partial<AssignDnsZoneDto>,
  ): Promise<ClusterDnsZoneEntity> {
    if (!dto) {
      return assignment;
    }
    if (dto.certificateProvider !== undefined) {
      assignment.certificateProvider = dto.certificateProvider;
    }
    if (dto.acmeEmail !== undefined) {
      assignment.acmeEmail = dto.acmeEmail;
    }
    if (dto.wildcardCertificate !== undefined) {
      assignment.wildcardCertificate = dto.wildcardCertificate;
    }

    return await this.clusterDnsZoneRepository.save(assignment);
  }

  async updateReconciliationStatus(
    id: string,
    status: ReconciliationStatus,
    errorMessage?: string,
  ): Promise<ClusterDnsZoneEntity> {
    const assignment = await this.getById(id);

    assignment.reconciliationStatus = status;
    assignment.errorMessage = errorMessage ?? null;

    if (
      status === ReconciliationStatus.IN_SYNC ||
      status === ReconciliationStatus.ERROR
    ) {
      assignment.lastReconciliationAt = new Date();
    }

    return await this.clusterDnsZoneRepository.save(assignment);
  }

  async getIssuers(clusterId: string): Promise<
    {
      name: string;
      ready: boolean;
      email: string | null;
      solverType: SolverType;
      message: string | null;
    }[]
  > {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const kubeconfig = await this.getKubeconfig(cluster);

    // Always check all 4 possible issuer names — return only those that exist
    const candidateNames = [
      'letsencrypt-staging',
      'letsencrypt-production',
      'letsencrypt-staging-wildcard',
      'letsencrypt-production-wildcard',
    ];

    const result: {
      name: string;
      ready: boolean;
      email: string | null;
      solverType: SolverType;
      message: string | null;
    }[] = [];

    for (const name of candidateNames) {
      const resource = await this.readClusterIssuerResilient(kubeconfig, name);

      if (resource) {
        const readyCondition = resource.status?.conditions?.find(
          (c: { type: string; status: string; message?: string }) =>
            c.type === 'Ready',
        );
        const solvers: any[] = resource.spec?.acme?.solvers ?? [];
        const hasDns01 = solvers.some((s) => s.dns01 != null);
        const hasHttp01 = solvers.some((s) => s.http01 != null);
        let solverType: SolverType = null;
        if (hasDns01 && hasHttp01) solverType = 'combined';
        else if (hasDns01) solverType = 'dns01';
        else if (hasHttp01) solverType = 'http01';

        result.push({
          name,
          ready: readyCondition?.status === 'True',
          email: resource.spec?.acme?.email ?? null,
          solverType,
          message: readyCondition?.message ?? null,
        });
      }
    }

    return result;
  }

  /**
   * Read a ClusterIssuer, tolerating transient cluster/API-server blips.
   *
   * `getResource` returns null on a clean 404 (issuer genuinely absent) and
   * throws on anything else (timeout, connection reset, 5xx). A single such
   * throw would otherwise abort the whole issuer scan and make an existing,
   * ready wildcard issuer look *missing* — which intermittently gated catalog
   * installs of building-block databases with "DNS zone not assigned". So we
   * retry only the thrown (transient) case; a 404 returns immediately (no
   * retry, no latency), and a persistent failure still surfaces after the
   * bounded attempts.
   */
  private async readClusterIssuerResilient(
    kubeconfig: string,
    name: string,
    attempts = 3,
    backoffMs = 400,
  ): Promise<Record<string, any> | null> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.kubernetesService.getResource(
          kubeconfig,
          'ClusterIssuer',
          name,
          '',
        );
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) {
          this.logger.warn(
            `Transient error reading ClusterIssuer ${name} (attempt ${i + 1}/${attempts}); retrying: ${err instanceof Error ? err.message : String(err)}`,
          );
          await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Returns the best available wildcard ClusterIssuer for the cluster, reading
   * live cert-manager state (the entity column is a preference hint only —
   * the actual issuers live in the cluster). Production is preferred over
   * staging when both are ready. Returns null when no wildcard issuer is
   * ready or when the cluster cannot be reached.
   */
  async resolveWildcardIssuer(clusterId: string): Promise<{
    issuerName: string;
    certificateProvider: CertificateProvider;
  } | null> {
    try {
      const issuers = await this.getIssuers(clusterId);
      const prod = issuers.find(
        (i) => i.name === 'letsencrypt-production-wildcard' && i.ready,
      );
      if (prod) {
        return {
          issuerName: prod.name,
          certificateProvider: CertificateProvider.LETS_ENCRYPT,
        };
      }
      const staging = issuers.find(
        (i) => i.name === 'letsencrypt-staging-wildcard' && i.ready,
      );
      if (staging) {
        return {
          issuerName: staging.name,
          certificateProvider: CertificateProvider.LETS_ENCRYPT_STAGING,
        };
      }
      return null;
    } catch (err) {
      this.logger.warn(
        `resolveWildcardIssuer(${clusterId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async configureIssuer(
    clusterId: string,
    dto: ConfigureIssuerDto,
  ): Promise<void> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const kubeconfig = await this.getKubeconfig(cluster);

    const assignments = await this.getZonesForCluster(clusterId);
    const useDns01 = assignments.some((a) => a.wildcardCertificate);

    await this.setZoneReconciliationStatusByClusterId(
      clusterId,
      ReconciliationStatus.RECONCILING,
    );

    try {
      await this.applyHttpIssuers(clusterId, kubeconfig, dto.acmeEmail);

      if (useDns01) {
        await this.applyDnsIssuers(clusterId, kubeconfig, dto.acmeEmail);
        // Internal apps reuse the public endpoint pipeline (per-app DNS
        // record + per-app cert via the wildcard DNS01 issuer we just
        // applied). No extra cluster-wide provisioning needed: once the
        // wildcard issuer is Ready, `hasInternalHosting` returns true.
      }

      await this.refreshAssignmentStatuses(clusterId);

      // Determine which issuer names to watch based on configuration
      const issuersToWatch = useDns01
        ? [...this.httpIssuerNames, ...this.dnsIssuerNames]
        : [...this.httpIssuerNames];

      // Fire-and-forget: poll until all configured issuers are ready and emit WebSocket events
      this.watchIssuers(
        clusterId,
        kubeconfig,
        dto.acmeEmail,
        issuersToWatch,
      ).catch((err) =>
        this.logger.error(
          `[${clusterId}] watchIssuers fatal error: ${err.message}`,
        ),
      );
    } catch (err) {
      const message = err?.message ?? String(err);
      await this.setZoneReconciliationStatusByClusterId(
        clusterId,
        ReconciliationStatus.ERROR,
        message,
      );
      throw err;
    }
  }

  async configureIssuerByType(
    clusterId: string,
    dto: ConfigureIssuerDto,
    type: 'http' | 'dns',
  ): Promise<void> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const kubeconfig = await this.getKubeconfig(cluster);

    await this.setZoneReconciliationStatusByClusterId(
      clusterId,
      ReconciliationStatus.RECONCILING,
    );

    try {
      if (type === 'http') {
        await this.applyHttpIssuers(clusterId, kubeconfig, dto.acmeEmail);
        await this.refreshAssignmentStatuses(clusterId);
        this.watchIssuers(clusterId, kubeconfig, dto.acmeEmail, [
          ...this.httpIssuerNames,
        ]).catch((err) =>
          this.logger.error(
            `[${clusterId}] watchIssuers fatal error: ${err.message}`,
          ),
        );
        return;
      }

      await this.applyDnsIssuers(clusterId, kubeconfig, dto.acmeEmail);
      await this.refreshAssignmentStatuses(clusterId);
      this.watchIssuers(clusterId, kubeconfig, dto.acmeEmail, [
        ...this.dnsIssuerNames,
      ]).catch((err) =>
        this.logger.error(
          `[${clusterId}] watchIssuers fatal error: ${err.message}`,
        ),
      );
    } catch (err) {
      const message = err?.message ?? String(err);
      await this.setZoneReconciliationStatusByClusterId(
        clusterId,
        ReconciliationStatus.ERROR,
        message,
      );
      throw err;
    }
  }

  async deleteIssuers(clusterId: string): Promise<void> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const kubeconfig = await this.getKubeconfig(cluster);
    const issuerNames = [...this.httpIssuerNames, ...this.dnsIssuerNames];
    await this.deleteIssuerNames(clusterId, kubeconfig, issuerNames);
  }

  async deleteIssuersByType(
    clusterId: string,
    type: 'http' | 'dns',
  ): Promise<void> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const kubeconfig = await this.getKubeconfig(cluster);
    const issuerNames =
      type === 'http' ? [...this.httpIssuerNames] : [...this.dnsIssuerNames];
    await this.deleteIssuerNames(clusterId, kubeconfig, issuerNames);
  }

  private async deleteIssuerNames(
    clusterId: string,
    kubeconfig: string,
    issuerNames: string[],
  ): Promise<void> {
    const deleted: string[] = [];
    const errors: string[] = [];

    for (const name of issuerNames) {
      try {
        await this.kubernetesService.deleteResource(
          kubeconfig,
          'ClusterIssuer',
          name,
          '',
        );
        deleted.push(name);
        this.logger.log(
          `Deleted ClusterIssuer ${name} from cluster ${clusterId}`,
        );
      } catch (err) {
        const msg = err?.message ?? String(err);
        // 404 = already gone — not an error
        if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
          deleted.push(name);
          this.logger.log(
            `ClusterIssuer ${name} already absent in cluster ${clusterId}`,
          );
        } else {
          errors.push(`${name}: ${msg}`);
          this.logger.warn(`Failed to delete ClusterIssuer ${name}: ${msg}`);
        }
      }
    }

    if (errors.length > 0) {
      this.clusterDnsGateway.emitIssuerDeletionFailed(clusterId, {
        clusterId,
        error: errors.join('; '),
        timestamp: new Date(),
      });
      throw new Error(`Failed to delete some issuers: ${errors.join('; ')}`);
    }

    this.clusterDnsGateway.emitIssuerDeleted(clusterId, {
      clusterId,
      deletedIssuers: deleted,
      timestamp: new Date(),
    });
  }

  /**
   * Bootstrap HTTP-01 ClusterIssuers (staging + production) on a cluster
   * without requiring a DNS zone assignment. Used by the cluster-creation
   * flow for IP-mode (nip.io) clusters where no zone is configured but
   * per-app endpoints still need an issuer to resolve.
   */
  async bootstrapHttpIssuersForCluster(
    clusterId: string,
    acmeEmail: string,
  ): Promise<void> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }
    const kubeconfig = await this.getKubeconfig(cluster);
    await this.applyHttpIssuers(clusterId, kubeconfig, acmeEmail);
  }

  private async applyHttpIssuers(
    clusterId: string,
    kubeconfig: string,
    acmeEmail: string,
  ): Promise<void> {
    for (const provider of [
      CertificateProvider.LETS_ENCRYPT_STAGING,
      CertificateProvider.LETS_ENCRYPT,
    ]) {
      const acmeServerUrl =
        this.acmeCertificateService.getAcmeServerUrl(provider);
      const issuerName =
        this.acmeCertificateService.getIssuerName(acmeServerUrl);
      const manifest =
        this.acmeCertificateService.generateClusterIssuerManifest({
          email: acmeEmail,
          server: acmeServerUrl,
          privateKeySecretRef: `${issuerName}-key`,
          solverType: 'http01',
        });
      await this.kubernetesService.applyManifest(kubeconfig, manifest);
      this.logger.log(
        `Applied ClusterIssuer ${issuerName} (http01) to cluster ${clusterId}`,
      );
    }
  }

  /**
   * Step 1 of DNS wildcard setup: apply the DNS credential Secret of every DNS
   * provider the cluster's zones live on, and confirm each is readable before
   * returning. cert-manager validates the Secret at ClusterIssuer apply time
   * via its informer cache — the Secret must exist and be consistent before
   * step 2 is called.
   */
  async applyDnsSecret(clusterId: string): Promise<void> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }
    const kubeconfig = await this.getKubeconfig(cluster);
    await this.applyDnsCredentialSecrets(clusterId, kubeconfig);
  }

  /**
   * Step 2 of DNS wildcard setup: apply the wildcard ClusterIssuers.
   * Requires the DNS credential Secrets to already exist (call applyDnsSecret
   * first) — a provider missing its Secret is dropped from the solver set, and
   * a cluster where no provider can solve DNS-01 gets a BadRequest naming the
   * blocker per zone.
   */
  async applyDnsIssuersOnly(
    clusterId: string,
    dto: ConfigureIssuerDto,
  ): Promise<void> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }
    const kubeconfig = await this.getKubeconfig(cluster);

    await this.setZoneReconciliationStatusByClusterId(
      clusterId,
      ReconciliationStatus.RECONCILING,
    );

    try {
      await this.applyDnsClusterIssuers(clusterId, kubeconfig, dto.acmeEmail);
      await this.refreshAssignmentStatuses(clusterId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.setZoneReconciliationStatusByClusterId(
        clusterId,
        ReconciliationStatus.ERROR,
        message,
      );
      throw err;
    }

    this.watchIssuers(clusterId, kubeconfig, dto.acmeEmail, [
      ...this.dnsIssuerNames,
    ]).catch((err) =>
      this.logger.error(
        `[${clusterId}] watchIssuers fatal error: ${err.message}`,
      ),
    );
  }

  /**
   * Why a DNS provider cannot solve DNS-01 on this cluster, or null when it
   * can. DNS-01 solvers delegate TXT-record writes to a cert-manager webhook
   * that registers its own API group (e.g. acme.hetzner.com): without the
   * webhook, issuers apply cleanly but every challenge stalls with a "cannot
   * create resource" error. The webhook is DNS-provider-specific and
   * independent of the compute provider, so it can legitimately be missing on
   * BYOS/cross-provider clusters.
   */
  private async dns01BlockReason(
    dnsProvider: DnsProvider,
    kubeconfig: string,
  ): Promise<string | null> {
    if (!this.acmeCertificateService.supportsDns01(dnsProvider)) {
      return (
        `DNS-01 is not supported for DNS provider "${dnsProvider}" ` +
        `(supported: ${this.acmeCertificateService.listDns01Providers().join(', ')})`
      );
    }
    const webhook =
      this.acmeCertificateService.getDns01WebhookConfig(dnsProvider);

    let apiService: { status?: any } | null = null;
    try {
      apiService = await this.kubernetesService.getResource(
        kubeconfig,
        'APIService',
        `v1alpha1.${webhook.groupName}`,
        '',
      );
    } catch (err) {
      // A transient read failure must not drop a working provider from the
      // solver set — assume installed and let the challenge surface the truth.
      this.logger.warn(
        `DNS-01 webhook APIService check failed for ${dnsProvider}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!apiService) {
      return (
        `the DNS-01 webhook for "${webhook.groupName}" is not installed on the cluster ` +
        `(APIService v1alpha1.${webhook.groupName} not found)`
      );
    }

    const secretReady = await this.kubernetesService.secretExists(
      kubeconfig,
      webhook.secretName,
      'cert-manager',
    );
    if (!secretReady) {
      return `the credential Secret "${webhook.secretName}" is missing in the cert-manager namespace`;
    }
    return null;
  }

  private async applyDnsIssuers(
    clusterId: string,
    kubeconfig: string,
    acmeEmail: string,
  ): Promise<void> {
    await this.applyDnsCredentialSecrets(clusterId, kubeconfig);
    await this.applyDnsClusterIssuers(clusterId, kubeconfig, acmeEmail);
  }

  /** Distinct DNS providers across the zones assigned to a cluster. */
  private async getDnsProvidersForCluster(
    clusterId: string,
  ): Promise<DnsProvider[]> {
    const assignments = await this.getZonesForCluster(clusterId);
    return [
      ...new Set(
        assignments
          .map((a) => a.dnsZone?.dnsProvider)
          .filter((p): p is DnsProvider => !!p),
      ),
    ];
  }

  /**
   * Applies one credential Secret per DNS provider present on the cluster.
   * Best-effort per provider: a provider whose credentials are not configured
   * is skipped and later reported on its own zones, rather than failing the
   * whole cluster.
   */
  private async applyDnsCredentialSecrets(
    clusterId: string,
    kubeconfig: string,
  ): Promise<DnsProvider[]> {
    const applied: DnsProvider[] = [];
    for (const dnsProvider of await this.getDnsProvidersForCluster(clusterId)) {
      if (!this.acmeCertificateService.supportsDns01(dnsProvider)) continue;
      try {
        const credential = await this.resolveDnsCredential(dnsProvider);
        const manifest =
          this.acmeCertificateService.generateDnsCredentialSecretManifest(
            dnsProvider,
            credential,
          );
        await this.kubernetesService.applyManifest(kubeconfig, manifest);

        const webhook =
          this.acmeCertificateService.getDns01WebhookConfig(dnsProvider);
        await this.kubernetesService.waitForSecret(
          kubeconfig,
          webhook.secretName,
          'cert-manager',
        );
        applied.push(dnsProvider);
        this.logger.log(
          `Applied DNS-01 credential Secret for ${dnsProvider} in cert-manager namespace for cluster ${clusterId}`,
        );
      } catch (err) {
        this.logger.warn(
          `Could not apply the DNS-01 credential Secret for ${dnsProvider} on cluster ${clusterId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return applied;
  }

  /** Reads the provider credential in the shape its cert-manager webhook expects. */
  private async resolveDnsCredential(
    dnsProvider: DnsProvider,
  ): Promise<Dns01Credential> {
    const cloudProvider = this.mapDnsProviderToCloudProvider(dnsProvider);
    const webhook =
      this.acmeCertificateService.getDns01WebhookConfig(dnsProvider);
    if (webhook.credential.kind === 'api_token') {
      return {
        kind: 'api_token',
        token: await this.credentialProvider.getActiveApiToken(cloudProvider),
      };
    }
    const pair =
      await this.credentialProvider.getActiveAccessKeyPair(cloudProvider);
    return {
      kind: 'access_key_pair',
      accessKey: pair.accessKey,
      secretKey: pair.secretKey,
    };
  }

  /**
   * Applies the wildcard ClusterIssuers with one dns01 solver per DNS provider
   * that can actually solve challenges, each selecting its own zones, plus the
   * http01 catch-all. A cluster whose zones span several providers needs one
   * solver each: the webhook and its credential Secret are provider-specific, so
   * a single-provider issuer drops every zone that is not on that provider.
   */
  /** Zone names of a cluster bucketed by the DNS provider that serves them. */
  private async groupZonesByProvider(
    clusterId: string,
  ): Promise<Map<DnsProvider, string[]>> {
    const byProvider = new Map<DnsProvider, string[]>();
    for (const assignment of await this.getZonesForCluster(clusterId)) {
      const dnsProvider = assignment.dnsZone?.dnsProvider;
      const zoneName = assignment.dnsZone?.zoneName;
      if (!dnsProvider || !zoneName) continue;
      byProvider.set(dnsProvider, [
        ...(byProvider.get(dnsProvider) ?? []),
        zoneName,
      ]);
    }
    return byProvider;
  }

  private async applyDnsClusterIssuers(
    clusterId: string,
    kubeconfig: string,
    acmeEmail: string,
  ): Promise<Dns01SolverSpec[]> {
    const zonesByProvider = await this.groupZonesByProvider(clusterId);

    const solvers: Dns01SolverSpec[] = [];
    const blocked: string[] = [];
    for (const [dnsProvider, zoneNames] of zonesByProvider) {
      const reason = await this.dns01BlockReason(dnsProvider, kubeconfig);
      if (reason) {
        blocked.push(`${zoneNames.join(', ')}: ${reason}`);
        continue;
      }
      solvers.push({ dnsProvider, zoneNames });
    }

    if (solvers.length === 0) {
      throw new BadRequestException(
        `No DNS zone assigned to cluster ${clusterId} can solve DNS-01 challenges. ` +
          (blocked.join('; ') || 'No DNS zone is assigned to this cluster.'),
      );
    }
    if (blocked.length > 0) {
      this.logger.warn(
        `[${clusterId}] wildcard issuers exclude some zones — ${blocked.join('; ')}`,
      );
    }

    const solverSummary = solvers
      .map((s) => `${s.dnsProvider}[${s.zoneNames.join(',')}]`)
      .join(' ');

    for (const provider of [
      CertificateProvider.LETS_ENCRYPT_STAGING,
      CertificateProvider.LETS_ENCRYPT,
    ]) {
      const acmeServerUrl =
        this.acmeCertificateService.getAcmeServerUrl(provider);
      const wildcardIssuerName =
        this.acmeCertificateService.getWildcardIssuerName(acmeServerUrl);
      const manifest =
        this.acmeCertificateService.generateCombinedClusterIssuerManifest({
          email: acmeEmail,
          server: acmeServerUrl,
          solvers,
        });
      await this.kubernetesService.applyManifest(kubeconfig, manifest);
      this.logger.log(
        `Applied ClusterIssuer ${wildcardIssuerName} (dns01+http01, solvers: ${solverSummary}) to cluster ${clusterId}`,
      );
    }
    return solvers;
  }

  /**
   * Recomputes the status of every assignment of a cluster from live state.
   * Status is per zone: a wildcard zone whose DNS provider cannot solve DNS-01
   * is ERROR with an actionable message instead of being marked IN_SYNC along
   * with the zones that are actually covered.
   */
  private async refreshAssignmentStatuses(clusterId: string): Promise<void> {
    const assignments = await this.getZonesForCluster(clusterId);
    if (assignments.length === 0) return;

    let kubeconfig: string | null = null;
    let wildcardIssuers: Awaited<ReturnType<typeof this.getIssuers>> = [];
    try {
      const cluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
      });
      if (cluster) kubeconfig = await this.getKubeconfig(cluster);
      const issuers = await this.getIssuers(clusterId);
      wildcardIssuers = issuers.filter((i) =>
        this.dnsIssuerNames.includes(i.name),
      );
    } catch (err) {
      this.logger.warn(
        `Could not read cluster ${clusterId} while refreshing DNS zone statuses: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    for (const assignment of assignments) {
      const { status, message } = await this.assignmentStatus(
        assignment,
        kubeconfig,
        wildcardIssuers,
      );
      await this.updateReconciliationStatus(assignment.id, status, message);
    }
  }

  /** The status one assignment should carry, given the cluster state just read. */
  private async assignmentStatus(
    assignment: ClusterDnsZoneEntity,
    kubeconfig: string | null,
    wildcardIssuers: Awaited<ReturnType<typeof this.getIssuers>>,
  ): Promise<{ status: ReconciliationStatus; message?: string }> {
    if (!assignment.wildcardCertificate) {
      return { status: ReconciliationStatus.IN_SYNC };
    }

    const zoneName = assignment.dnsZone?.zoneName ?? assignment.dnsZoneId;
    const dnsProvider = assignment.dnsZone?.dnsProvider;
    const reason =
      dnsProvider && kubeconfig
        ? await this.dns01BlockReason(dnsProvider, kubeconfig)
        : `zone ${zoneName} has no DNS provider`;
    if (reason) {
      return {
        status: ReconciliationStatus.ERROR,
        message: `Wildcard TLS unavailable for ${zoneName}: ${reason}. Per-host HTTP-01 certificates still work.`,
      };
    }

    if (wildcardIssuers.length === 0) {
      return {
        status: ReconciliationStatus.PENDING,
        message:
          'Wildcard ClusterIssuer not configured yet — set the ACME email to finish the DNS-01 setup.',
      };
    }

    if (!wildcardIssuers.some((i) => i.ready)) {
      return {
        status: ReconciliationStatus.RECONCILING,
        message:
          wildcardIssuers[0].message ??
          'Waiting for the wildcard ClusterIssuer to register with ACME',
      };
    }

    return { status: ReconciliationStatus.IN_SYNC };
  }

  private async watchIssuers(
    clusterId: string,
    kubeconfig: string,
    email: string,
    issuerNames: string[] = ['letsencrypt-staging', 'letsencrypt-production'],
  ): Promise<void> {
    const POLL_INTERVAL_MS = 5000;
    const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
    const startTime = Date.now();
    const readySet = new Set<string>();

    while (Date.now() - startTime < TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      for (const name of issuerNames) {
        if (readySet.has(name)) continue;

        try {
          const resource = await this.kubernetesService.getResource(
            kubeconfig,
            'ClusterIssuer',
            name,
            '',
          );

          if (!resource) continue;

          const readyCondition = resource.status?.conditions?.find(
            (c: { type: string; status: string; message?: string }) =>
              c.type === 'Ready',
          );
          const isReady = readyCondition?.status === 'True';
          const message =
            readyCondition?.message ?? 'Waiting for ACME registration';

          this.clusterDnsGateway.emitIssuerStatus(clusterId, {
            clusterId,
            issuerName: name,
            ready: isReady,
            message,
            timestamp: new Date(),
          });

          if (isReady) {
            readySet.add(name);
          }
        } catch (err) {
          this.logger.warn(
            `[${clusterId}] issuer poll error for ${name}: ${err.message}`,
          );
        }
      }

      if (readySet.size === issuerNames.length) {
        const issuers = issuerNames.map((name) => ({
          name,
          ready: true,
          email,
        }));
        // ACME registration is asynchronous: the zone statuses written when the
        // manifests were applied still say RECONCILING, and nothing else would
        // ever revisit them.
        await this.refreshAssignmentStatuses(clusterId);
        this.clusterDnsGateway.emitIssuerConfigured(clusterId, {
          clusterId,
          issuers,
          duration: Date.now() - startTime,
          timestamp: new Date(),
        });
        return;
      }
    }

    // Timeout: emit failure for any issuer that didn't become ready
    const notReady = issuerNames.filter((n) => !readySet.has(n));
    await this.refreshAssignmentStatuses(clusterId);
    this.clusterDnsGateway.emitIssuerConfigurationFailed(clusterId, {
      clusterId,
      error: `Issuers not ready after timeout: ${notReady.join(', ')}`,
      timestamp: new Date(),
    });
  }

  async getCertDiagnostics(
    clusterId: string,
    namespace?: string,
  ): Promise<CertDiagnosticsResponseDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const kubeconfig = await this.getKubeconfig(cluster);

    // Pass undefined to list across all namespaces; pass a specific namespace to filter.
    // Certificates live in the app namespace (e.g. 'default'), NOT in 'cert-manager'.
    const [rawCerts, rawRequests, rawOrders, rawChallenges] = await Promise.all(
      [
        this.kubernetesService.listCrdResources(
          kubeconfig,
          'Certificate',
          namespace,
        ),
        this.kubernetesService.listCrdResources(
          kubeconfig,
          'CertificateRequest',
          namespace,
        ),
        this.kubernetesService.listCrdResources(kubeconfig, 'Order', namespace),
        this.kubernetesService.listCrdResources(
          kubeconfig,
          'Challenge',
          namespace,
        ),
      ],
    );

    const challenges: AcmeChallengeInfoDto[] = rawChallenges.map((r) => {
      const c = r.body ?? r;
      return {
        name: c.metadata?.name ?? '',
        dnsName: c.spec?.dnsName ?? '',
        type: c.spec?.type ?? '',
        status: c.status?.state ?? 'unknown',
        reason: c.status?.reason ?? null,
        message: (c.status?.reason as string) ?? null,
        url: c.spec?.url ?? null,
      };
    });

    const orders: AcmeOrderInfoDto[] = rawOrders.map((r) => {
      const o = r.body ?? r;
      const ownerName = o.metadata?.name ?? '';
      const orderChallenges = challenges.filter((ch) => {
        const raw = rawChallenges.find(
          (rc) => (rc.body ?? rc).metadata?.name === ch.name,
        );
        if (!raw) return false;
        const c = raw.body ?? raw;
        return c.metadata?.ownerReferences?.some(
          (ref: { name: string }) => ref.name === ownerName,
        );
      });
      return {
        name: ownerName,
        state: o.status?.state ?? 'unknown',
        reason: o.status?.reason ?? null,
        message: o.status?.failureMessage ?? null,
        failureTime: o.status?.failureTime ?? null,
        url: o.spec?.request ?? null,
        challenges: orderChallenges,
      };
    });

    const certificates: CertificateDiagnosticsDto[] = rawCerts.map((r) => {
      const cert = r.body ?? r;
      const certName: string = cert.metadata?.name ?? '';
      const readyCondition = cert.status?.conditions?.find(
        (c: { type: string }) => c.type === 'Ready',
      );

      const certRequests: CertificateRequestInfoDto[] = rawRequests
        .filter((rr) => {
          const cr = rr.body ?? rr;
          return (
            cr.metadata?.annotations?.['cert-manager.io/certificate-name'] ===
            certName
          );
        })
        .map((rr) => {
          const cr = rr.body ?? rr;
          const crName: string = cr.metadata?.name ?? '';
          const crReady = cr.status?.conditions?.find(
            (c: { type: string }) => c.type === 'Ready',
          );
          const crApproved = cr.status?.conditions?.find(
            (c: { type: string }) => c.type === 'Approved',
          );

          const matchedOrder =
            orders.find((o) => isOrderOwnedByRequest(o, rawOrders, crName)) ??
            null;

          return {
            name: crName,
            ready: crReady ? crReady.status === 'True' : null,
            reason: crReady?.reason ?? crApproved?.reason ?? null,
            message: crReady?.message ?? null,
            failureTime: cr.status?.failureTime ?? null,
            order: matchedOrder,
          };
        });

      return {
        name: certName,
        namespace:
          (cert.metadata?.namespace as string) ?? namespace ?? 'unknown',
        ready: readyCondition ? readyCondition.status === 'True' : null,
        reason: readyCondition?.reason ?? null,
        message: readyCondition?.message ?? null,
        notAfter: cert.status?.notAfter ?? null,
        renewalTime: cert.status?.renewalTime ?? null,
        requests: certRequests,
      };
    });

    return {
      clusterId,
      namespace: namespace ?? 'all',
      certificates,
    };
  }

  private mapDnsProviderToCloudProvider(
    dnsProvider: DnsProvider,
  ): CloudProvider {
    if (dnsProvider === DnsProvider.HETZNER) {
      return CloudProvider.HETZNER;
    }
    if (dnsProvider === DnsProvider.SCALEWAY) {
      return CloudProvider.SCALEWAY;
    }
    throw new Error(
      `No cloud provider mapping for DNS provider "${dnsProvider}"`,
    );
  }

  private async getKubeconfig(cluster: ClusterEntity): Promise<string> {
    if (!cluster.kubeconfigEncrypted) {
      throw new Error(`Cluster ${cluster.id} has no kubeconfig`);
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    return this.kubernetesService.patchKubeconfigServer(kubeconfig);
  }

  private async setZoneReconciliationStatusByClusterId(
    clusterId: string,
    status: ReconciliationStatus,
    errorMessage?: string,
  ): Promise<void> {
    const assignments = await this.getZonesForCluster(clusterId);
    for (const assignment of assignments) {
      await this.updateReconciliationStatus(
        assignment.id,
        status,
        errorMessage,
      );
    }
  }

  async getSystemDnsStatus(
    clusterId: string,
  ): Promise<SystemDnsStatusResponseDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const kubeconfig = await this.getKubeconfig(cluster);
    const authMode = await this.readAuthMode(kubeconfig);
    const isLocalMode = authMode === 'local';

    const [apiApp, webApp, zitadelApp] = await Promise.all([
      this.applicationRepository.findOne({
        where: { clusterId, slug: 'flui-api' },
      }),
      this.applicationRepository.findOne({
        where: { clusterId, slug: 'flui-web' },
      }),
      isLocalMode
        ? Promise.resolve(null)
        : this.applicationRepository.findOne({
            where: { clusterId, slug: 'zitadel' },
          }),
    ]);

    const [apiEndpoint, webEndpoint, zitadelEndpoint] = await Promise.all([
      apiApp
        ? this.appEndpointRepository.findOne({
            where: { applicationId: apiApp.id },
          })
        : null,
      webApp
        ? this.appEndpointRepository.findOne({
            where: { applicationId: webApp.id },
          })
        : null,
      zitadelApp
        ? this.appEndpointRepository.findOne({
            where: { applicationId: zitadelApp.id },
          })
        : null,
    ]);

    const apiProgress = this.deriveSetupProgress(apiEndpoint);
    const webProgress = this.deriveSetupProgress(webEndpoint);

    return {
      fluiApi: {
        applicationId: apiApp?.id ?? null,
        endpointId: apiEndpoint?.id ?? null,
        domain: apiEndpoint?.fqdn ?? null,
        ...apiProgress,
      },
      fluiWeb: {
        applicationId: webApp?.id ?? null,
        endpointId: webEndpoint?.id ?? null,
        domain: webEndpoint?.fqdn ?? null,
        ...webProgress,
      },
      zitadel: isLocalMode
        ? null
        : {
            applicationId: zitadelApp?.id ?? null,
            endpointId: zitadelEndpoint?.id ?? null,
            domain: zitadelEndpoint?.fqdn ?? null,
            ...this.deriveSetupProgress(zitadelEndpoint),
          },
    };
  }

  private async readAuthMode(kubeconfig: string): Promise<string> {
    try {
      const configMap = await this.kubernetesService.getResource(
        kubeconfig,
        'ConfigMap',
        'flui-api-config',
        'flui-system',
      );
      const cmBody = configMap?.body ?? configMap;
      return cmBody?.data?.['AUTH_MODE'] ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private deriveSetupProgress(endpoint: AppEndpointEntity | null): {
    stagingCertConfigured: boolean;
    prodCertConfigured: boolean;
    synced: boolean;
    syncedDomain: string | null;
    lastSyncedAt: Date | null;
  } {
    if (!endpoint) {
      return {
        stagingCertConfigured: false,
        prodCertConfigured: false,
        synced: false,
        syncedDomain: null,
        lastSyncedAt: null,
      };
    }
    return {
      stagingCertConfigured:
        endpoint.certificateProvider ===
          CertificateProvider.LETS_ENCRYPT_STAGING &&
        endpoint.certificateStatus === CertificateStatus.VALID,
      prodCertConfigured:
        endpoint.certificateProvider === CertificateProvider.LETS_ENCRYPT &&
        endpoint.certificateStatus === CertificateStatus.VALID,
      synced:
        endpoint.syncedDomain !== null &&
        endpoint.syncedDomain === endpoint.fqdn,
      syncedDomain: endpoint.syncedDomain ?? null,
      lastSyncedAt: endpoint.lastSyncedAt ?? null,
    };
  }

  private async getSystemAppStatus(
    kubeconfig: string,
    ingressName: string,
    tlsSecretName: string,
    namespace: string,
  ): Promise<SystemAppDnsStatusDto> {
    try {
      const ingress = await this.kubernetesService.getResource(
        kubeconfig,
        'Ingress',
        ingressName,
        namespace,
      );
      if (!ingress) {
        return {
          domain: null,
          ingressConfigured: false,
          certConfigured: false,
          certStatus: null,
          certMessage: null,
        };
      }

      const ingressBody = ingress.body ?? ingress;
      const domain: string | null = ingressBody.spec?.rules?.[0]?.host ?? null;
      const cert = await this.kubernetesService.getResource(
        kubeconfig,
        'Certificate',
        tlsSecretName,
        namespace,
      );

      if (!cert) {
        return {
          domain,
          ingressConfigured: true,
          certConfigured: false,
          certStatus: null,
          certMessage: null,
        };
      }

      const certBody = cert.body ?? cert;
      const conditions: Array<{
        type: string;
        status: string;
        reason?: string;
        message?: string;
      }> = certBody.status?.conditions ?? [];
      const readyCondition = conditions.find((c) => c.type === 'Ready');
      const certStatus = this.mapCertificateStatusFromCondition(readyCondition);

      return {
        domain,
        ingressConfigured: true,
        certConfigured: true,
        certStatus,
        certMessage: readyCondition?.message ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to get system app status for ${ingressName}: ${err.message}`,
      );
      return {
        domain: null,
        ingressConfigured: false,
        certConfigured: false,
        certStatus: null,
        certMessage: null,
      };
    }
  }

  private async getZitadelStatus(
    kubeconfig: string,
  ): Promise<SystemAppDnsStatusDto> {
    try {
      // Zitadel uses Traefik IngressRoute CRD (traefik.io/v1alpha1)
      const ingressRoute = await this.kubernetesService.getResource(
        kubeconfig,
        'IngressRoute',
        'zitadel',
        'default',
      );

      if (!ingressRoute) {
        return {
          domain: null,
          ingressConfigured: false,
          certConfigured: false,
          certStatus: null,
          certMessage: null,
        };
      }

      const ingressRouteBody = ingressRoute.body ?? ingressRoute;
      const routes: Array<{ match?: string }> =
        ingressRouteBody.spec?.routes ?? [];
      let domain: string | null = null;
      for (const route of routes) {
        const routeMatch = route.match ?? '';
        const hostMatch = /Host\(`([^`]+)`\)/.exec(routeMatch);
        if (hostMatch) {
          domain = hostMatch[1];
          break;
        }
      }

      // IngressRoute with tls:{} uses Traefik default cert — no dedicated Certificate object
      const tlsConfigured =
        ingressRouteBody.spec?.tls !== undefined &&
        ingressRouteBody.spec?.tls !== null;

      return {
        domain,
        ingressConfigured: true,
        certConfigured: tlsConfigured,
        certStatus: tlsConfigured ? CertificateStatus.VALID : null,
        certMessage: tlsConfigured
          ? 'Managed by Traefik default certificate'
          : null,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to get Zitadel IngressRoute status: ${err.message}`,
      );
      return {
        domain: null,
        ingressConfigured: false,
        certConfigured: false,
        certStatus: null,
        certMessage: null,
      };
    }
  }

  private mapCertificateStatusFromCondition(readyCondition?: {
    type: string;
    status: string;
    reason?: string;
  }): CertificateStatus {
    if (!readyCondition) return CertificateStatus.PENDING;
    if (readyCondition.status === 'True') return CertificateStatus.VALID;
    if (readyCondition.reason === 'Expired') return CertificateStatus.EXPIRED;
    // DoesNotExist, Issuing, MissingData — all mean cert-manager is actively working on it
    if (
      readyCondition.reason === 'Issuing' ||
      readyCondition.reason === 'DoesNotExist' ||
      readyCondition.reason === 'MissingData' ||
      readyCondition.reason === 'InProgress'
    ) {
      return CertificateStatus.ISSUING;
    }
    return CertificateStatus.FAILED;
  }

  toResponseDto(assignment: ClusterDnsZoneEntity): ClusterDnsZoneResponseDto {
    return {
      id: assignment.id,
      clusterId: assignment.clusterId,
      dnsZoneId: assignment.dnsZoneId,
      dnsZone: assignment.dnsZone
        ? {
            id: assignment.dnsZone.id,
            providerZoneId: assignment.dnsZone.providerZoneId,
            zoneName: assignment.dnsZone.zoneName,
            dnsProvider: assignment.dnsZone.dnsProvider,
            description: assignment.dnsZone.description,
            recordTtlSeconds: assignment.dnsZone.recordTtlSeconds,
            replicas: (assignment.dnsZone.replicas ?? []).map((r) => ({
              id: r.id,
              dnsZoneId: r.dnsZoneId,
              dnsProvider: r.dnsProvider,
              providerZoneId: r.providerZoneId,
              status: r.status,
              lastReconciledAt: r.lastReconciledAt ?? null,
              errorMessage: r.errorMessage ?? null,
              createdAt: r.createdAt,
              updatedAt: r.updatedAt,
            })),
            createdAt: assignment.dnsZone.createdAt,
            updatedAt: assignment.dnsZone.updatedAt,
          }
        : null,
      certificateProvider: assignment.certificateProvider,
      acmeEmail: assignment.acmeEmail,
      wildcardCertificate: assignment.wildcardCertificate,
      reconciliationStatus: assignment.reconciliationStatus,
      lastReconciliationAt: assignment.lastReconciliationAt,
      errorMessage: assignment.errorMessage,
      createdAt: assignment.createdAt,
      updatedAt: assignment.updatedAt,
    };
  }
}
