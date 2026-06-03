import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { DnsProviderFactory } from '../../providers/services/dns-provider.factory';
import { AcmeCertificateService } from '../../providers/services/acme-certificate.service';
import { AppEndpointService } from './app-endpoint.service';
import { ClusterDnsZoneService } from './cluster-dns-zone.service';
import { WildcardCertificateService } from './wildcard-certificate.service';
import { SanCertificateService } from './san-certificate.service';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { ClusterDnsZoneEntity } from '../entities/cluster-dns-zone.entity';
import { DnsRecordInfo } from '../../providers/interfaces/dns-provider.interface';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { EndpointType } from '../enums/endpoint-type.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { CertChallenge } from '../enums/cert-challenge.enum';
import { ClusterAuthzInstallRepository } from '../../authz/repositories/cluster-authz-install.repository';
import { ClusterDnsGateway } from '../gateway/cluster-dns.gateway';

@Injectable()
export class AppEndpointReconciliationService {
  private readonly logger = new Logger(AppEndpointReconciliationService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly dnsProviderFactory: DnsProviderFactory,
    private readonly acmeCertificateService: AcmeCertificateService,
    private readonly appEndpointService: AppEndpointService,
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
    private readonly authzInstallRepo: ClusterAuthzInstallRepository,
    private readonly wildcardCertificateService: WildcardCertificateService,
    private readonly sanCertificateService: SanCertificateService,
    private readonly clusterDnsGateway: ClusterDnsGateway,
  ) {}

  private resolveCertProvider(
    endpoint: AppEndpointEntity,
  ): CertificateProvider | undefined {
    const explicit =
      endpoint.certificateProvider ??
      endpoint.clusterDnsZone?.certificateProvider;
    if (explicit) return explicit;
    if (
      process.env.FLUI_NIPIO_TLS === 'true' &&
      endpoint.certificateRequired &&
      !endpoint.fqdn.startsWith('*.')
    ) {
      return CertificateProvider.LETS_ENCRYPT;
    }
    return undefined;
  }

  private async resolveReadyIssuerOrNull(
    endpoint: AppEndpointEntity,
    certProvider: CertificateProvider,
  ): Promise<{ issuerName: string } | null> {
    const useDns01 =
      endpoint.certChallenge === CertChallenge.DNS_01 ||
      endpoint.fqdn.startsWith('*.');
    const acmeServer =
      this.acmeCertificateService.getAcmeServerUrl(certProvider);
    const expected = useDns01
      ? this.acmeCertificateService.getWildcardIssuerName(acmeServer)
      : this.acmeCertificateService.getIssuerName(acmeServer);

    try {
      const issuers = await this.clusterDnsZoneService.getIssuers(
        endpoint.clusterId,
      );
      const match = issuers.find((i) => i.name === expected && i.ready);
      if (match) return { issuerName: match.name };

      const present = issuers.find((i) => i.name === expected);
      if (present) {
        this.logger.warn(
          `[cert-gate] endpoint=${endpoint.id} fqdn=${endpoint.fqdn}: ClusterIssuer ${expected} present but not Ready (${present.message ?? 'no message'}) — skipping TLS for this endpoint`,
        );
      } else {
        this.logger.warn(
          `[cert-gate] endpoint=${endpoint.id} fqdn=${endpoint.fqdn}: ClusterIssuer ${expected} not installed on cluster ${endpoint.clusterId} — skipping TLS for this endpoint`,
        );
      }
      return null;
    } catch (err) {
      this.logger.warn(
        `[cert-gate] endpoint=${endpoint.id} could not enumerate ClusterIssuers on cluster ${endpoint.clusterId}: ${err instanceof Error ? err.message : String(err)} — skipping TLS for this endpoint`,
      );
      return null;
    }
  }

  private emitEndpointCertStatus(
    endpoint: AppEndpointEntity,
    status: CertificateStatus | null,
    message: string | null,
  ): void {
    if (!status) return;
    this.clusterDnsGateway.emitEndpointCertStatus(endpoint.clusterId, {
      clusterId: endpoint.clusterId,
      endpointId: endpoint.id,
      fqdn: endpoint.fqdn,
      certificateStatus: status,
      certificateMessage: message,
      tlsEnabled:
        !!endpoint.certificateRequired && status === CertificateStatus.VALID,
      timestamp: new Date(),
    });
  }

  async reconcile(endpointId: string): Promise<void> {
    const endpoint = await this.appEndpointService.getEndpoint(endpointId);

    // Short-circuit: if a reconciliation is already in progress (e.g. the
    // catalog install processor just triggered one fire-and-forget, and the
    // frontend now calls POST /reconcile as a belt-and-suspenders), avoid
    // racing on the DNS provider — reconcileDnsRecord does check-then-create
    // without a lock, so concurrent callers with dnsRecordId=null would
    // create duplicate records. Safety net, not a proper mutex: a caller
    // that wants to force a re-reconcile should wait for completion.
    if (endpoint.reconciliationStatus === ReconciliationStatus.RECONCILING) {
      this.logger.log(
        `Reconciliation for ${endpointId} already in progress — skipping duplicate trigger`,
      );
      return;
    }

    this.logger.log(`Starting reconciliation for endpoint ${endpointId}`);
    const cluster = await this.getCluster(endpoint.clusterId);

    await this.appEndpointService.updateReconciliationStatus(
      endpointId,
      ReconciliationStatus.RECONCILING,
    );

    try {
      // SAN binding takes precedence over wildcard tiered: when an endpoint
      // is bound to a SAN cert, the master Secret already covers its fqdn,
      // so we materialize the replica in the app namespace and skip the
      // per-host emission and the wildcard tiered flow entirely.
      if (endpoint.sanCertificateId && endpoint.certificateRequired) {
        this.logger.log(
          `[san] endpoint=${endpointId} bound to san=${endpoint.sanCertificateId} fqdn=${endpoint.fqdn} ns=${endpoint.k8sNamespace}`,
        );
        const san = await this.sanCertificateService.ensureForEndpoint(
          endpoint.sanCertificateId,
          endpoint.k8sNamespace,
          endpoint.fqdn,
        );
        endpoint.tlsSecretName = san.tlsSecretName;
        await this.appEndpointService.setSanBinding(
          endpointId,
          san.sanCertificateId,
          san.tlsSecretName,
        );
        this.logger.log(
          `[san] endpoint=${endpointId} secret=${san.tlsSecretName} ready=${san.ready}`,
        );
      }

      const wildcardEnabled =
        !endpoint.sanCertificateId &&
        this.wildcardCertificateService.isEnabled();
      this.logger.log(
        `[wildcard] endpoint=${endpointId} flag=${wildcardEnabled} certRequired=${endpoint.certificateRequired} hasZone=${!!endpoint.clusterDnsZone} fqdn=${endpoint.fqdn}`,
      );
      if (
        wildcardEnabled &&
        endpoint.certificateRequired &&
        endpoint.clusterDnsZone
      ) {
        this.logger.log(
          `[wildcard] endpoint=${endpointId} entering wildcard branch; calling ensureForEndpoint(${endpoint.clusterId}, ${endpoint.fqdn}, ${endpoint.k8sNamespace})`,
        );
        const wildcard =
          await this.wildcardCertificateService.ensureForEndpoint(
            endpoint.clusterId,
            endpoint.fqdn,
            endpoint.k8sNamespace,
          );
        if (wildcard) {
          this.logger.log(
            `[wildcard] endpoint=${endpointId} bound to wildcard=${wildcard.wildcardCertificateId} secret=${wildcard.tlsSecretName} ready=${wildcard.ready}`,
          );
          await this.appEndpointService.setWildcardBinding(
            endpointId,
            wildcard.wildcardCertificateId,
            wildcard.tlsSecretName,
          );
          endpoint.wildcardCertificateId = wildcard.wildcardCertificateId;
          endpoint.tlsSecretName = wildcard.tlsSecretName;
        } else {
          this.logger.warn(
            `[wildcard] endpoint=${endpointId} ensureForCluster returned null — falling back to per-host`,
          );
        }
      } else if (wildcardEnabled) {
        this.logger.warn(
          `[wildcard] endpoint=${endpointId} flag on but guards failed (certRequired=${endpoint.certificateRequired}, hasZone=${!!endpoint.clusterDnsZone}) — using per-host`,
        );
      }

      let dnsRecordId: string | undefined;
      let dnsRecordValue: string | undefined;

      // DNS record + certificate emission follow the exact same pipeline for
      // public and internal endpoints: per-app A record on the DNS provider,
      // cert issued by cert-manager via DNS01 (wildcard issuer) or HTTP01.
      // The ONLY difference between public and internal endpoints is:
      //   1. FQDN pattern: `<slug>.internal.<zone>` vs `<slug>.<zone>`
      //   2. Traefik Middleware ForwardAuth in front (see reconcileIngress):
      //      internal endpoints gate every request through /authz/internal-app.
      // Keeping DNS/cert identical avoids ever ending up with an internal app
      // exposed publicly by accident — the security boundary is the
      // Middleware, applied fail-closed before the Ingress.
      const isIpHostname = endpoint.hostnameMode === HostnameMode.IP;
      if (endpoint.clusterDnsZone && !isIpHostname) {
        const result = await this.reconcileDnsRecord(
          endpoint,
          endpoint.clusterDnsZone,
          cluster,
        );
        dnsRecordId = result.recordId;
        dnsRecordValue = result.value;
      } else if (isIpHostname) {
        this.logger.log(
          `Endpoint ${endpointId} uses IP hostname mode (nip.io) — skipping DNS record management`,
        );
      } else {
        this.logger.log(
          `Endpoint ${endpointId} has no cluster DNS zone — skipping DNS record management (BYOD)`,
        );
      }

      const configuredCertProvider: CertificateProvider | undefined =
        this.resolveCertProvider(endpoint);

      const usesWildcardBinding = !!endpoint.wildcardCertificateId;
      const usesSanBinding = !!endpoint.sanCertificateId;
      const usesSharedSecret = usesWildcardBinding || usesSanBinding;

      let effectiveCertProvider = configuredCertProvider;
      let certGateMessage: string | null = null;
      if (
        endpoint.certificateRequired &&
        configuredCertProvider &&
        !usesSharedSecret
      ) {
        const ready = await this.resolveReadyIssuerOrNull(
          endpoint,
          configuredCertProvider,
        );
        if (!ready) {
          effectiveCertProvider = undefined;
          certGateMessage =
            'No Ready ClusterIssuer on the target cluster — TLS skipped. DNS record was created; configure a ClusterIssuer (cert-manager) and re-reconcile to enable HTTPS.';
        }
      }

      await this.reconcileService(endpoint, cluster);
      await this.reconcileIngress(
        endpoint,
        endpoint.clusterDnsZone,
        cluster,
        effectiveCertProvider,
      );

      let certStatus: CertificateStatus | null | undefined;
      if (
        endpoint.certificateRequired &&
        (effectiveCertProvider || usesWildcardBinding || usesSanBinding)
      ) {
        if (usesSanBinding) {
          certStatus = await this.resolveSanEndpointStatus(endpoint);
        } else if (usesWildcardBinding) {
          certStatus = await this.resolveWildcardEndpointStatus(endpoint);
        } else {
          certStatus = CertificateStatus.ISSUING;
        }
      }

      await this.appEndpointService.markReconciliationComplete(
        endpointId,
        dnsRecordId,
        dnsRecordValue,
        certStatus,
        certGateMessage ?? undefined,
      );

      this.emitEndpointCertStatus(
        endpoint,
        certStatus ?? null,
        certGateMessage,
      );

      this.logger.log(
        `Reconciliation completed for endpoint ${endpointId} (${endpoint.fqdn})`,
      );
    } catch (error) {
      this.logger.error(
        `Reconciliation failed for endpoint ${endpointId}: ${error.message}`,
      );

      await this.appEndpointService.updateReconciliationStatus(
        endpointId,
        ReconciliationStatus.ERROR,
        error.message,
      );

      throw error;
    }
  }

  async reconcileAllForCluster(clusterId: string): Promise<void> {
    const endpoints = await this.appEndpointService.listEndpoints(clusterId);

    this.logger.log(
      `Reconciling ${endpoints.length} endpoints for cluster ${clusterId}`,
    );

    for (const endpoint of endpoints) {
      try {
        await this.reconcile(endpoint.id);
      } catch (error) {
        this.logger.error(
          `Failed to reconcile endpoint ${endpoint.id} (${endpoint.fqdn}): ${error.message}`,
        );
      }
    }
  }

  async deleteEndpointResources(endpointId: string): Promise<void> {
    const endpoint = await this.appEndpointService.getEndpoint(endpointId);
    const cluster = await this.getCluster(endpoint.clusterId);

    try {
      const kubeconfig = await this.getKubeconfig(cluster);

      const ingressName = `${endpoint.k8sServiceName}-ingress`;
      await this.kubernetesService.deleteResource(
        kubeconfig,
        'Ingress',
        ingressName,
        endpoint.k8sNamespace,
      );
      this.logger.log(
        `Deleted ingress ${ingressName} for endpoint ${endpoint.fqdn}`,
      );

      // Delete Certificate and TLS Secret created by cert-manager for this endpoint.
      // Skip when the endpoint uses the shared wildcard Secret (reflector replica):
      // it may be referenced by other endpoints in the same namespace.
      if (
        endpoint.certificateRequired &&
        !endpoint.wildcardCertificateId &&
        !endpoint.sanCertificateId
      ) {
        const safeName = endpoint.fqdn
          .replaceAll('.', '-')
          .replaceAll('*', 'wildcard');
        await this.kubernetesService.deleteResource(
          kubeconfig,
          'Certificate',
          `tls-${safeName}`,
          endpoint.k8sNamespace,
        );
        await this.kubernetesService.deleteResource(
          kubeconfig,
          'Secret',
          `tls-${safeName}`,
          endpoint.k8sNamespace,
        );
        this.logger.log(
          `Deleted Certificate and TLS Secret for ${endpoint.fqdn}`,
        );
      }

      // Delete the Traefik ForwardAuth Middleware for internal endpoints.
      if (endpoint.endpointType === EndpointType.INTERNAL) {
        try {
          await this.kubernetesService.deleteResource(
            kubeconfig,
            'Middleware',
            `${endpoint.k8sServiceName}-forwardauth`,
            endpoint.k8sNamespace,
          );
          this.logger.log(
            `Deleted Traefik Middleware ${endpoint.k8sServiceName}-forwardauth for ${endpoint.fqdn}`,
          );
        } catch (err) {
          this.logger.warn(
            `Traefik Middleware delete skipped for ${endpoint.fqdn}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Delete the K8s Service only if it was created by flui (has managed-by label)
      const svc = await this.kubernetesService.getResource(
        kubeconfig,
        'Service',
        endpoint.k8sServiceName,
        endpoint.k8sNamespace,
      );
      const isFluiManagedService =
        svc?.metadata?.labels?.['managed-by'] === 'flui-cloud' ||
        svc?.metadata?.labels?.['app.kubernetes.io/managed-by'] ===
          'flui-cloud';
      if (isFluiManagedService) {
        await this.kubernetesService.deleteResource(
          kubeconfig,
          'Service',
          endpoint.k8sServiceName,
          endpoint.k8sNamespace,
        );
        this.logger.log(
          `Deleted flui-managed Service ${endpoint.k8sServiceName} for endpoint ${endpoint.fqdn}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to delete K8s resources for endpoint ${endpointId}: ${error.message}`,
      );
    }

    if (endpoint.dnsRecordId && endpoint.clusterDnsZone) {
      try {
        const dnsZone = endpoint.clusterDnsZone.dnsZone;
        const dnsProvider = this.dnsProviderFactory.getDnsProviderOrFail(
          dnsZone.dnsProvider,
        );
        await dnsProvider.deleteRecord(
          dnsZone.providerZoneId,
          endpoint.dnsRecordId,
        );
        this.logger.log(
          `Deleted DNS record ${endpoint.dnsRecordId} for ${endpoint.fqdn}`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to delete DNS record for endpoint ${endpointId}: ${error.message}`,
        );
      }
    }
  }

  async getCertificateStatus(endpointId: string): Promise<{
    status: CertificateStatus | null;
    message: string | null;
  }> {
    const endpoint = await this.appEndpointService.getEndpoint(endpointId);

    if (!endpoint.certificateRequired) {
      return { status: null, message: null };
    }

    const cluster = await this.getCluster(endpoint.clusterId);
    const kubeconfig = await this.getKubeconfig(cluster);

    if (endpoint.sanCertificateId) {
      return await this.getSanCertificateStatus(
        endpoint.sanCertificateId,
        kubeconfig,
      );
    }
    if (endpoint.wildcardCertificateId) {
      return await this.getWildcardCertificateStatus(
        endpoint.wildcardCertificateId,
        kubeconfig,
      );
    }

    const effectiveCertProvider = this.resolveCertProvider(endpoint);
    if (!effectiveCertProvider) {
      return { status: null, message: null };
    }

    try {
      const safeName = endpoint.fqdn
        .replaceAll('.', '-')
        .replaceAll('*', 'wildcard');
      const tlsSecretName = `tls-${safeName}`;

      const resource = await this.kubernetesService.getResource(
        kubeconfig,
        'Certificate',
        tlsSecretName,
        endpoint.k8sNamespace,
      );

      if (!resource) {
        return { status: CertificateStatus.PENDING, message: null };
      }

      const body = resource.body ?? resource;
      const conditions: Array<{
        type: string;
        status: string;
        reason?: string;
        message?: string;
      }> = body.status?.conditions ?? [];
      const readyCondition = conditions.find((c) => c.type === 'Ready');
      const issuingCondition = conditions.find((c) => c.type === 'Issuing');
      const certStatus = this.mapCertificateStatus(
        readyCondition,
        issuingCondition,
      );

      // If still issuing, pull the latest error from active Challenges
      let message: string | null = readyCondition?.message ?? null;
      if (
        certStatus === CertificateStatus.ISSUING ||
        certStatus === CertificateStatus.FAILED
      ) {
        const challengeMessage = await this.getActiveChallengeMessage(
          kubeconfig,
          endpoint.k8sNamespace,
          endpoint.fqdn,
        );
        if (challengeMessage) {
          message = challengeMessage;
        }
      }

      return { status: certStatus, message };
    } catch (error) {
      this.logger.error(
        `Failed to get certificate status for endpoint ${endpointId}: ${error.message}`,
      );
      return { status: null, message: null };
    }
  }

  private async resolveWildcardEndpointStatus(
    endpoint: AppEndpointEntity,
  ): Promise<CertificateStatus> {
    try {
      const cluster = await this.getCluster(endpoint.clusterId);
      const kubeconfig = await this.getKubeconfig(cluster);
      const result = await this.getWildcardCertificateStatus(
        endpoint.wildcardCertificateId,
        kubeconfig,
      );
      return result.status ?? CertificateStatus.ISSUING;
    } catch {
      return CertificateStatus.ISSUING;
    }
  }

  private async resolveSanEndpointStatus(
    endpoint: AppEndpointEntity,
  ): Promise<CertificateStatus> {
    try {
      const cluster = await this.getCluster(endpoint.clusterId);
      const kubeconfig = await this.getKubeconfig(cluster);
      const result = await this.getSanCertificateStatus(
        endpoint.sanCertificateId,
        kubeconfig,
      );
      return result.status ?? CertificateStatus.ISSUING;
    } catch {
      return CertificateStatus.ISSUING;
    }
  }

  private async getSanCertificateStatus(
    sanCertificateId: string,
    kubeconfig: string,
  ): Promise<{ status: CertificateStatus | null; message: string | null }> {
    const san = await this.sanCertificateService.getById(sanCertificateId);
    try {
      const resource = await this.kubernetesService.getResource(
        kubeconfig,
        'Certificate',
        san.masterCertName,
        san.masterNamespace,
      );
      if (!resource) {
        return { status: CertificateStatus.PENDING, message: null };
      }
      const body = resource.body ?? resource;
      const conditions: Array<{
        type: string;
        status: string;
        reason?: string;
        message?: string;
      }> = body.status?.conditions ?? [];
      const readyCondition = conditions.find((c) => c.type === 'Ready');
      const issuingCondition = conditions.find((c) => c.type === 'Issuing');
      const status = this.mapCertificateStatus(
        readyCondition,
        issuingCondition,
      );
      return {
        status,
        message:
          readyCondition?.message ??
          (status === CertificateStatus.VALID
            ? 'SAN certificate is valid'
            : null),
      };
    } catch (err) {
      this.logger.warn(
        `Failed to read SAN Certificate ${san.masterNamespace}/${san.masterCertName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: null, message: null };
    }
  }

  private async getWildcardCertificateStatus(
    wildcardCertificateId: string,
    kubeconfig: string,
  ): Promise<{ status: CertificateStatus | null; message: string | null }> {
    const wildcard = await this.wildcardCertificateService.getById(
      wildcardCertificateId,
    );
    if (!wildcard) {
      return { status: null, message: 'Wildcard certificate record missing' };
    }

    try {
      const resource = await this.kubernetesService.getResource(
        kubeconfig,
        'Certificate',
        wildcard.masterCertName,
        wildcard.masterNamespace,
      );
      if (!resource) {
        return { status: CertificateStatus.PENDING, message: null };
      }
      const body = resource.body ?? resource;
      const conditions: Array<{
        type: string;
        status: string;
        reason?: string;
        message?: string;
      }> = body.status?.conditions ?? [];
      const readyCondition = conditions.find((c) => c.type === 'Ready');
      const issuingCondition = conditions.find((c) => c.type === 'Issuing');
      const status = this.mapCertificateStatus(
        readyCondition,
        issuingCondition,
      );
      return {
        status,
        message:
          readyCondition?.message ??
          (status === CertificateStatus.VALID
            ? 'Wildcard certificate is valid'
            : null),
      };
    } catch (err) {
      this.logger.warn(
        `Failed to read wildcard Certificate ${wildcard.masterNamespace}/${wildcard.masterCertName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: null, message: null };
    }
  }

  private async getActiveChallengeMessage(
    kubeconfig: string,
    namespace: string,
    fqdn: string,
  ): Promise<string | null> {
    try {
      const challenges = await this.kubernetesService.listCrdResources(
        kubeconfig,
        'Challenge',
        namespace,
      );
      if (!challenges?.length) return null;

      // Find challenges for this fqdn
      const matching = challenges.filter(
        (c: any) => (c.body ?? c).spec?.dnsName === fqdn,
      );
      if (!matching.length) return null;

      // Return the most recent reason/message from the challenge status
      const challenge = matching.at(-1);
      const body = challenge.body ?? challenge;
      return (body.status?.reason as string) ?? null;
    } catch {
      return null;
    }
  }

  private async reconcileDnsRecord(
    endpoint: AppEndpointEntity,
    clusterDnsZone: ClusterDnsZoneEntity,
    cluster: ClusterEntity,
  ): Promise<DnsRecordInfo> {
    const dnsZone = clusterDnsZone.dnsZone;
    const dnsProvider = this.dnsProviderFactory.getDnsProviderOrFail(
      dnsZone.dnsProvider,
    );

    const recordValue = endpoint.dnsRecordValue ?? cluster.masterIpAddress;
    if (!recordValue) {
      throw new Error(
        `Cannot create DNS record for endpoint ${endpoint.id}: no IP address available. ` +
          `Make sure the cluster has a master IP address or provide dnsRecordValue explicitly.`,
      );
    }

    const recordName = this.resolveRecordName(endpoint.fqdn, dnsZone.zoneName);

    if (endpoint.dnsRecordId) {
      const existing = await dnsProvider.getRecord(
        dnsZone.providerZoneId,
        endpoint.dnsRecordId,
      );

      if (existing && existing.value !== recordValue) {
        this.logger.log(
          `Updating DNS record ${endpoint.dnsRecordId} for ${endpoint.fqdn}`,
        );
        return await dnsProvider.updateRecord({
          recordId: endpoint.dnsRecordId,
          zoneId: dnsZone.providerZoneId,
          type: endpoint.dnsRecordType,
          name: recordName,
          value: recordValue,
          ttl: 300,
        });
      }

      if (existing) {
        return existing;
      }
    }

    this.logger.log(
      `Creating DNS record for ${endpoint.fqdn} → ${recordValue}`,
    );
    return await dnsProvider.createRecord({
      zoneId: dnsZone.providerZoneId,
      type: endpoint.dnsRecordType,
      name: recordName,
      value: recordValue,
      ttl: 300,
      labels: {
        'managed-by': 'flui-cloud',
        'flui-resource-type': 'dns-record',
        'flui-cluster-id': cluster.id,
        'flui-endpoint-id': endpoint.id,
      },
    });
  }

  private async reconcileService(
    endpoint: AppEndpointEntity,
    cluster: ClusterEntity,
  ): Promise<void> {
    const kubeconfig = await this.getKubeconfig(cluster);

    const existing = await this.kubernetesService.getResource(
      kubeconfig,
      'Service',
      endpoint.k8sServiceName,
      endpoint.k8sNamespace,
    );

    if (existing) {
      this.logger.log(
        `Service ${endpoint.k8sServiceName} already exists in ${endpoint.k8sNamespace} — skipping creation`,
      );
      return;
    }

    const manifest: Record<string, unknown> = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: endpoint.k8sServiceName,
        namespace: endpoint.k8sNamespace,
        labels: {
          'managed-by': 'flui-cloud',
          'flui-cluster-id': cluster.id,
          'flui-resource-type': 'app-service',
          'flui-endpoint-id': endpoint.id,
        },
      },
      spec: {
        type: 'ClusterIP',
        selector: {
          // Pods are labelled `app: <slug>`. The service name may have a `-svc` suffix
          // (user apps) or match the slug directly (system apps). Strip the suffix to
          // derive the correct pod selector label.
          app: endpoint.k8sServiceName.replace(/-svc$/, ''),
        },
        ports: [
          {
            port: endpoint.k8sServicePort,
            targetPort: endpoint.k8sServicePort,
            protocol: 'TCP',
          },
        ],
      },
    };

    await this.kubernetesService.applyManifest(
      kubeconfig,
      JSON.stringify(manifest),
    );
    this.logger.log(
      `Created ClusterIP Service ${endpoint.k8sServiceName}:${endpoint.k8sServicePort} in ${endpoint.k8sNamespace}`,
    );
  }

  private async reconcileIngress(
    endpoint: AppEndpointEntity,
    clusterDnsZone: ClusterDnsZoneEntity | null,
    cluster: ClusterEntity,
    effectiveCertProvider?: CertificateProvider,
  ): Promise<void> {
    const kubeconfig = await this.getKubeconfig(cluster);
    const ingressName = `${endpoint.k8sServiceName}-ingress`;

    // If the existing Ingress points to a different host (fqdn changed),
    // clean up the stale TLS secret and Certificate before reapplying.
    const existingIngress = await this.kubernetesService.getResource(
      kubeconfig,
      'Ingress',
      ingressName,
      endpoint.k8sNamespace,
    );
    if (existingIngress) {
      const existingHost: string | undefined =
        existingIngress.spec?.rules?.[0]?.host;
      if (existingHost && existingHost !== endpoint.fqdn) {
        this.logger.log(
          `fqdn changed from ${existingHost} to ${endpoint.fqdn} — cleaning up stale K8s resources`,
        );
        const staleSafeName = existingHost
          .replaceAll('.', '-')
          .replaceAll('*', 'wildcard');
        await this.kubernetesService.deleteResource(
          kubeconfig,
          'Certificate',
          `tls-${staleSafeName}`,
          endpoint.k8sNamespace,
        );
        await this.kubernetesService.deleteResource(
          kubeconfig,
          'Secret',
          `tls-${staleSafeName}`,
          endpoint.k8sNamespace,
        );
      }
    }

    const hasCert = endpoint.certificateRequired && !!effectiveCertProvider;
    const usesWildcard =
      !!endpoint.wildcardCertificateId && !!endpoint.tlsSecretName;
    const usesSan = !!endpoint.sanCertificateId && !!endpoint.tlsSecretName;
    const usesSharedSecret = usesWildcard || usesSan;
    const safeName = endpoint.fqdn
      .replaceAll('.', '-')
      .replaceAll('*', 'wildcard');
    const tlsSecretName = usesSharedSecret
      ? endpoint.tlsSecretName
      : `tls-${safeName}`;
    const useDns01 =
      endpoint.certChallenge === CertChallenge.DNS_01 ||
      endpoint.fqdn.startsWith('*.');
    let issuerName: string;
    if (!effectiveCertProvider) {
      issuerName = 'letsencrypt-production';
    } else {
      const acmeUrl = this.acmeCertificateService.getAcmeServerUrl(
        effectiveCertProvider,
      );
      issuerName = useDns01
        ? this.acmeCertificateService.getWildcardIssuerName(acmeUrl)
        : this.acmeCertificateService.getIssuerName(acmeUrl);
    }

    const isInternal = endpoint.endpointType === EndpointType.INTERNAL;

    // For internal endpoints the cluster uses Traefik: gate the Ingress via
    // a Traefik Middleware (forwardAuth) applied in the same namespace as
    // the app, referenced from the Ingress through
    // `traefik.ingress.kubernetes.io/router.middlewares`.
    //
    // Fail-closed: if we cannot apply the Middleware for any reason
    // (no discoverable Flui API public URL, apiserver error, ...), we refuse
    // to create the Ingress — better "app unreachable" than "app exposed
    // publicly without authz".
    const traefikMiddlewareRef = isInternal
      ? await this.applyInternalForwardAuthMiddleware(
          kubeconfig,
          endpoint.k8sNamespace,
          endpoint.k8sServiceName,
          cluster.id,
        )
      : null;
    if (isInternal && !traefikMiddlewareRef) {
      throw new Error(
        `Refusing to apply Ingress for internal endpoint ${endpoint.id} (${endpoint.fqdn}): ForwardAuth Middleware could not be applied. Ensure the backend has a discoverable public URL (PUBLIC_API_URL / FLUI_API_ENDPOINT / API_BASE_URL) — these are populated by ApiDomainSyncService after DNS config. Failing closed so the app is NOT exposed publicly without authz.`,
      );
    }

    const manifest: Record<string, unknown> = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: ingressName,
        namespace: endpoint.k8sNamespace,
        annotations: {
          'traefik.ingress.kubernetes.io/router.entrypoints':
            hasCert || usesSharedSecret ? 'web,websecure' : 'web',
          ...(hasCert && !usesSharedSecret
            ? { 'cert-manager.io/cluster-issuer': issuerName }
            : {}),
          ...(traefikMiddlewareRef
            ? {
                'traefik.ingress.kubernetes.io/router.middlewares':
                  traefikMiddlewareRef,
              }
            : {}),
        },
        labels: {
          'managed-by': 'flui-cloud',
          'flui-cluster-id': cluster.id,
          'flui-resource-type': 'dns-ingress',
          'flui-endpoint-id': endpoint.id,
          ...(isInternal ? { 'flui-endpoint-type': 'internal' } : {}),
        },
      },
      spec: {
        ...(hasCert || usesSharedSecret
          ? {
              tls: [{ hosts: [endpoint.fqdn], secretName: tlsSecretName }],
            }
          : {}),
        rules: [
          {
            host: endpoint.fqdn,
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: {
                      name: endpoint.k8sServiceName,
                      port: { number: endpoint.k8sServicePort },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    };

    await this.kubernetesService.applyManifest(
      kubeconfig,
      JSON.stringify(manifest),
    );
    this.logger.log(`Applied Ingress ${ingressName} for ${endpoint.fqdn}`);
  }

  /**
   * Apply a Traefik Middleware (kind: Middleware, apiVersion: traefik.io/v1alpha1)
   * that does ForwardAuth against Flui's `/authz/internal-app` endpoint. The
   * middleware lives in the same namespace as the app so the Ingress can
   * reference it via `<ns>-<name>@kubernetescrd`.
   *
   * Returns the middleware reference string to put in the Ingress
   * annotation, or `null` if it could not be applied — in which case the
   * caller MUST refuse to create the Ingress (fail-closed).
   */
  private async applyInternalForwardAuthMiddleware(
    kubeconfig: string,
    namespace: string,
    serviceName: string,
    clusterId: string,
  ): Promise<string | null> {
    const inClusterInstall =
      await this.authzInstallRepo.findRunningForCluster(clusterId);

    let forwardAuthAddress: string;
    if (inClusterInstall) {
      forwardAuthAddress =
        'http://flui-authz.flui-system.svc.cluster.local/authz';
    } else {
      const fluiApiUrl = (
        process.env.PUBLIC_API_URL ||
        process.env.FLUI_API_ENDPOINT ||
        process.env.API_BASE_URL ||
        process.env.WEBHOOK_BASE_URL ||
        ''
      ).replace(/\/+$/, '');
      if (!fluiApiUrl) {
        this.logger.error(
          'No Flui API public URL discoverable and flui-authz not installed on cluster — cannot apply ForwardAuth Middleware. Install flui-authz via POST /authz/install or configure PUBLIC_API_URL.',
        );
        return null;
      }
      forwardAuthAddress = `${fluiApiUrl}/api/v1/authz/internal-app`;
    }

    const middlewareName = `${serviceName}-forwardauth`;
    const manifest: Record<string, unknown> = {
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'Middleware',
      metadata: {
        name: middlewareName,
        namespace,
        labels: {
          'managed-by': 'flui-cloud',
          'flui-resource-type': 'internal-forwardauth',
        },
      },
      spec: {
        forwardAuth: {
          address: forwardAuthAddress,
          trustForwardHeader: true,
          authResponseHeaders: ['X-Auth-User', 'X-Auth-Email', 'X-Auth-App'],
        },
      },
    };
    try {
      await this.kubernetesService.applyManifest(
        kubeconfig,
        JSON.stringify(manifest),
      );
    } catch (err) {
      this.logger.error(
        `Failed to apply Traefik ForwardAuth Middleware ${namespace}/${middlewareName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    // Traefik middleware reference format for CRD provider:
    // `<namespace>-<name>@kubernetescrd`
    return `${namespace}-${middlewareName}@kubernetescrd`;
  }

  private resolveRecordName(fqdn: string, zoneName: string): string {
    if (fqdn === zoneName) {
      return '@';
    }

    if (fqdn.endsWith(`.${zoneName}`)) {
      return fqdn.slice(0, fqdn.length - zoneName.length - 1);
    }

    return fqdn;
  }

  private async getCluster(clusterId: string): Promise<ClusterEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });

    if (!cluster) {
      throw new Error(`Cluster ${clusterId} not found`);
    }

    return cluster;
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

  private mapCertificateStatus(
    readyCondition?: { type: string; status: string; reason?: string },
    issuingCondition?: { type: string; status: string; reason?: string },
  ): CertificateStatus {
    if (!readyCondition) return CertificateStatus.PENDING;
    if (readyCondition.status === 'True') return CertificateStatus.VALID;
    if (readyCondition.reason === 'Expired') return CertificateStatus.EXPIRED;
    // If the Issuing condition is True, cert-manager is actively working on it
    if (issuingCondition?.status === 'True') return CertificateStatus.ISSUING;
    if (readyCondition.reason === 'Issuing') return CertificateStatus.ISSUING;
    return CertificateStatus.FAILED;
  }
}
