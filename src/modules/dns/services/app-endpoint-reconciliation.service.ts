import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as dnsPromises from 'node:dns/promises';
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
import { DnsZoneEntity } from '../entities/dns-zone.entity';
import {
  DnsRecordInfo,
  DnsRecordType,
  IDnsProvider,
} from '../../providers/interfaces/dns-provider.interface';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { EndpointType } from '../enums/endpoint-type.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { CertChallenge } from '../enums/cert-challenge.enum';
import { ClusterAuthzInstallRepository } from '../../authz/repositories/cluster-authz-install.repository';
import { ClusterDnsGateway } from '../gateway/cluster-dns.gateway';
import { DnsZoneReconciliationService } from './dns-zone-reconciliation.service';
import { resolveRecordName } from '../utils/resolve-record-name.util';
import { GatewayMiddlewareCompilerService } from './gateway-middleware-compiler.service';
import { describeError } from '../../shared/utils/error.util';
import { SandboxTenantEntity } from '../../sandbox/entities/sandbox-tenant.entity';
import { sandboxNoindexMiddlewareRef } from '../../sandbox/constants/sandbox-noindex';
import { ENDPOINT_ID_LABEL } from '../constants/endpoint-labels';

// A full reconcile — including the DNS-propagation gate — stays well under a
// minute; anything holding the lock for this long is a crashed process, not work.
const STALE_RECONCILE_LOCK_MS = 10 * 60 * 1000;

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
    private readonly dnsZoneReconciliationService: DnsZoneReconciliationService,
    private readonly gatewayCompiler: GatewayMiddlewareCompilerService,
    @InjectRepository(SandboxTenantEntity)
    private readonly sandboxTenants: Repository<SandboxTenantEntity>,
  ) {}

  private resolveCertProvider(
    endpoint: AppEndpointEntity,
  ): CertificateProvider | undefined {
    const explicit =
      endpoint.certificateProvider ??
      endpoint.clusterDnsZone?.certificateProvider;
    if (explicit) return explicit;
    // Default-on per-host LE cert for nip.io endpoints; opt out with FLUI_NIPIO_TLS=false.
    if (
      process.env.FLUI_NIPIO_TLS !== 'false' &&
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

  /**
   * Create-time issuer bootstrap can be missed (cluster created by another API
   * instance, or ADMIN_EMAIL unset at the time), leaving endpoints stuck on
   * plain HTTP — so a missing http-01 issuer is bootstrapped on demand here.
   * dns-01/wildcard is not self-healed: it needs the DNS-token Secret flow.
   */
  private async resolveReadyIssuerOrSelfHeal(
    endpoint: AppEndpointEntity,
    cluster: ClusterEntity,
    certProvider: CertificateProvider,
  ): Promise<{ issuerName: string } | null> {
    const initial = await this.resolveReadyIssuerOrNull(endpoint, certProvider);
    if (initial) return initial;

    const useDns01 =
      endpoint.certChallenge === CertChallenge.DNS_01 ||
      endpoint.fqdn.startsWith('*.');
    if (useDns01) return null;

    const acmeEmail =
      process.env.ADMIN_EMAIL ||
      (typeof cluster.metadata?.adminEmail === 'string'
        ? cluster.metadata.adminEmail
        : undefined);
    if (!acmeEmail) {
      this.logger.warn(
        `[cert-gate] endpoint=${endpoint.id}: no Ready ClusterIssuer and cannot self-heal — ADMIN_EMAIL not set and cluster ${cluster.id} has no adminEmail`,
      );
      return null;
    }

    this.logger.log(
      `[cert-gate] endpoint=${endpoint.id}: no Ready ClusterIssuer on cluster ${cluster.id} — bootstrapping HTTP issuers on-demand`,
    );
    try {
      await this.clusterDnsZoneService.bootstrapHttpIssuersForCluster(
        cluster.id,
        acmeEmail,
      );
    } catch (err) {
      this.logger.warn(
        `[cert-gate] endpoint=${endpoint.id}: on-demand issuer bootstrap failed on cluster ${cluster.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const ready = await this.resolveReadyIssuerOrNull(endpoint, certProvider);
      if (ready) {
        this.logger.log(
          `[cert-gate] endpoint=${endpoint.id}: self-healed — ClusterIssuer ${ready.issuerName} is now Ready`,
        );
        return ready;
      }
    }

    this.logger.warn(
      `[cert-gate] endpoint=${endpoint.id}: issuers bootstrapped but not Ready yet — TLS deferred to next reconcile`,
    );
    return null;
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
    if (this.isReconcileInFlight(endpoint)) {
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
      // A certificate is an enhancement over reachability, never a precondition
      // for it: DNS, Service and Ingress all come later in this method, so letting
      // a binding failure escape would cost the app its A record and its Ingress
      // over a TLS problem — the app disappears instead of degrading. The block
      // below already treats "no wildcard available" (a null return) as a
      // fall-back to per-host issuance; a throw is the same situation reported
      // differently, so it takes the same path and the reason is carried to the
      // endpoint for the user to see.
      const certBindingFailure = await this.bindSharedCertificate(endpoint);
      if (certBindingFailure) {
        this.logger.warn(
          `[cert] endpoint=${endpointId} shared-certificate binding failed, continuing with per-host issuance: ${certBindingFailure}`,
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
        // Empty when the zone's wildcard already answers for this name: there
        // is no per-app record, and nothing for teardown to delete.
        dnsRecordId = result.recordId || undefined;
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
        const gate = await this.gateCertificateIssuance(
          endpoint,
          cluster,
          configuredCertProvider,
          dnsRecordValue,
        );
        effectiveCertProvider = gate.provider;
        certGateMessage = gate.message;
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

      // The binding failure is the more specific of the two: the gate message only
      // says TLS was skipped, while this says why the shared certificate was
      // unavailable in the first place.
      const certMessage = certBindingFailure ?? certGateMessage;

      await this.appEndpointService.markReconciliationComplete(
        endpointId,
        dnsRecordId,
        dnsRecordValue,
        certStatus,
        certMessage ?? undefined,
      );

      this.emitEndpointCertStatus(endpoint, certStatus ?? null, certMessage);

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

  /**
   * Whether another reconciliation is genuinely still running for this endpoint.
   *
   * RECONCILING is written before the work starts, so a process that dies
   * mid-flight leaves the row locked forever — and every later trigger, including
   * the user's explicit retry, silently no-ops against a lock nobody holds. Past
   * the deadline the holder cannot still be alive: no step of a reconcile waits
   * anywhere near that long.
   */
  private isReconcileInFlight(endpoint: AppEndpointEntity): boolean {
    if (endpoint.reconciliationStatus !== ReconciliationStatus.RECONCILING) {
      return false;
    }
    const heldForMs = Date.now() - (endpoint.updatedAt?.getTime() ?? 0);
    if (heldForMs < STALE_RECONCILE_LOCK_MS) return true;
    this.logger.warn(
      `Reconciliation lock for ${endpoint.id} is stale (held ${Math.round(heldForMs / 1000)}s) — taking it over`,
    );
    return false;
  }

  /**
   * Bind the endpoint to a shared certificate (SAN, else the cluster wildcard),
   * mutating `endpoint` in place. Returns null on success or when there was
   * nothing to bind, otherwise the reason the binding could not be made — the
   * caller degrades to per-host issuance and surfaces the reason rather than
   * failing the endpoint, since neither DNS nor the Ingress depends on this.
   */
  private async bindSharedCertificate(
    endpoint: AppEndpointEntity,
  ): Promise<string | null> {
    const endpointId = endpoint.id;
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
        return null;
      }

      // An explicit http-01 request opts the endpoint out of the shared wildcard.
      const wildcardEnabled =
        !endpoint.sanCertificateId &&
        endpoint.certChallenge !== CertChallenge.HTTP_01 &&
        this.wildcardCertificateService.isEnabled();
      this.logger.log(
        `[wildcard] endpoint=${endpointId} flag=${wildcardEnabled} certRequired=${endpoint.certificateRequired} hasZone=${!!endpoint.clusterDnsZone} fqdn=${endpoint.fqdn}`,
      );
      if (!wildcardEnabled) return null;

      if (!endpoint.certificateRequired || !endpoint.clusterDnsZone) {
        this.logger.warn(
          `[wildcard] endpoint=${endpointId} flag on but guards failed (certRequired=${endpoint.certificateRequired}, hasZone=${!!endpoint.clusterDnsZone}) — using per-host`,
        );
        return null;
      }

      this.logger.log(
        `[wildcard] endpoint=${endpointId} entering wildcard branch; calling ensureForEndpoint(${endpoint.clusterId}, ${endpoint.fqdn}, ${endpoint.k8sNamespace})`,
      );
      const wildcard = await this.wildcardCertificateService.ensureForEndpoint(
        endpoint.clusterId,
        endpoint.fqdn,
        endpoint.k8sNamespace,
      );
      if (!wildcard) {
        this.logger.warn(
          `[wildcard] endpoint=${endpointId} ensureForCluster returned null — falling back to per-host`,
        );
        return null;
      }

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
      return null;
    } catch (error) {
      return describeError(error);
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

  /**
   * {@link deleteEndpointResources} reaches the cluster first, and after a
   * rebuild the row already names the new one — it would delete the Ingress
   * just created. Best effort: failing a rebuild over a stale record is worse.
   */
  async releaseDnsRecord(endpointId: string): Promise<void> {
    const endpoint = await this.appEndpointService.getEndpoint(endpointId);
    if (!endpoint.dnsRecordId || !endpoint.clusterDnsZone) return;
    const dnsZone = endpoint.clusterDnsZone.dnsZone;
    try {
      const dnsProvider = this.dnsProviderFactory.getDnsProviderOrFail(
        dnsZone.dnsProvider,
      );
      await dnsProvider.deleteRecord(
        dnsZone.providerZoneId,
        endpoint.dnsRecordId,
      );
      this.logger.log(
        `Released DNS record ${endpoint.dnsRecordId} for ${endpoint.fqdn}`,
      );
    } catch (error: any) {
      this.logger.warn(
        `Could not release the DNS record for ${endpoint.fqdn}; it will keep ` +
          `answering with an address nothing serves: ${error?.message}`,
      );
    }
    await this.appEndpointService.clearDnsRecord(endpoint.id);
  }

  async deleteEndpointResources(endpointId: string): Promise<void> {
    const endpoint = await this.appEndpointService.getEndpoint(endpointId);
    const cluster = await this.getCluster(endpoint.clusterId);

    try {
      const kubeconfig = await this.getKubeconfig(cluster);

      const ingressName = this.ingressNameFor(endpoint);
      await this.kubernetesService.deleteResource(
        kubeconfig,
        'Ingress',
        ingressName,
        endpoint.k8sNamespace,
      );
      await this.deleteLegacyIngressIfOwned(kubeconfig, endpoint);
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

      // Delete the gateway-policy Middlewares (allowlist/ratelimit/sso).
      await this.deleteGatewayMiddlewares(kubeconfig, endpoint);

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

      // Delete the K8s Service only if THIS endpoint is the one that created it.
      //
      // "Created by flui" was the condition and it is far too wide: the
      // application's own Service is created by flui too, so removing a gateway
      // route took the application off the air — the Ingress stayed, the
      // Service under it did not. `reconcileService` stamps the endpoint id on
      // the Services it creates and skips creation when one is already there,
      // so that label is exactly the register of "mine to delete". A Service
      // without it belongs to the application's deployment and is that
      // deployment's to remove.
      const svc = await this.kubernetesService.getResource(
        kubeconfig,
        'Service',
        endpoint.k8sServiceName,
        endpoint.k8sNamespace,
      );
      const createdByThisEndpoint =
        svc?.metadata?.labels?.[ENDPOINT_ID_LABEL] === endpoint.id;
      if (createdByThisEndpoint) {
        await this.kubernetesService.deleteResource(
          kubeconfig,
          'Service',
          endpoint.k8sServiceName,
          endpoint.k8sNamespace,
        );
        this.logger.log(
          `Deleted Service ${endpoint.k8sServiceName}, created for endpoint ${endpoint.fqdn}`,
        );
      } else if (svc) {
        this.logger.log(
          `Kept Service ${endpoint.k8sServiceName} in ${endpoint.k8sNamespace}: ` +
            `endpoint ${endpoint.fqdn} did not create it`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to delete K8s resources for endpoint ${endpointId}: ${error.message}`,
      );
    }

    if (endpoint.dnsRecordId && endpoint.clusterDnsZone) {
      const dnsZone = endpoint.clusterDnsZone.dnsZone;
      let primaryDeleteError: unknown;
      try {
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
        await this.appEndpointService.clearDnsRecord(endpoint.id);
      } catch (error) {
        primaryDeleteError = error;
        this.logger.warn(
          `Failed to delete DNS record for endpoint ${endpointId}: ${error.message}`,
        );
      }

      // Mirror the delete to any redundancy replicas (best-effort, never throws).
      await this.dnsZoneReconciliationService.fanOutDeleteToReplicas(
        dnsZone,
        resolveRecordName(endpoint.fqdn, dnsZone.zoneName),
        endpoint.dnsRecordType,
      );

      if (primaryDeleteError) {
        throw primaryDeleteError;
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

  /**
   * Decides whether a per-host certificate can be requested now. Two gates:
   * a Ready ClusterIssuer must exist (self-healing the http-01 pair when
   * missing), and — for zone-managed hostnames — the DNS record must already
   * be visible on the zone's authoritative nameservers. The DNS gate exists
   * because the FIRST recursive lookup of a name decides whether an NXDOMAIN
   * gets negative-cached for the zone's SOA minimum (1h on Hetzner): letting
   * cert-manager self-check before propagation poisons the cluster's resolver
   * chain and stalls the ACME challenge for up to an hour.
   */
  private async gateCertificateIssuance(
    endpoint: AppEndpointEntity,
    cluster: ClusterEntity,
    configuredCertProvider: CertificateProvider,
    dnsRecordValue: string | undefined,
  ): Promise<{
    provider: CertificateProvider | undefined;
    message: string | null;
  }> {
    const ready = await this.resolveReadyIssuerOrSelfHeal(
      endpoint,
      cluster,
      configuredCertProvider,
    );
    if (!ready) {
      return {
        provider: undefined,
        message:
          endpoint.hostnameMode === HostnameMode.IP
            ? 'No Ready ClusterIssuer on the target cluster — TLS skipped. The nip.io hostname resolves automatically; configure a ClusterIssuer (cert-manager) and re-reconcile to enable HTTPS.'
            : 'No Ready ClusterIssuer on the target cluster — TLS skipped. DNS record was created; configure a ClusterIssuer (cert-manager) and re-reconcile to enable HTTPS.',
      };
    }

    const zoneName = endpoint.clusterDnsZone?.dnsZone?.zoneName;
    if (
      endpoint.hostnameMode !== HostnameMode.IP &&
      zoneName &&
      dnsRecordValue
    ) {
      const propagated = await this.waitForAuthoritativeDnsPropagation(
        endpoint.fqdn,
        zoneName,
        dnsRecordValue,
      );
      if (!propagated) {
        return {
          provider: undefined,
          message:
            'DNS record not yet visible on the zone authoritative nameservers — ' +
            'TLS deferred so the ACME self-check cannot negative-cache the name. ' +
            'Re-reconcile to enable HTTPS.',
        };
      }
    }

    return { provider: configuredCertProvider, message: null };
  }

  /**
   * Polls the zone's authoritative nameservers (queried directly, bypassing
   * every recursive resolver and its cache) until the endpoint's record is
   * visible. Fail-open on infrastructure errors: the gate protects against
   * negative caching, it must never become a new way to block issuance.
   */
  private async waitForAuthoritativeDnsPropagation(
    fqdn: string,
    zoneName: string,
    expectedValue: string,
    timeoutMs = 60_000,
    pollMs = 2_000,
  ): Promise<boolean> {
    let servers: string[];
    try {
      const nsNames = await dnsPromises.resolveNs(zoneName);
      const addresses = await Promise.all(
        nsNames.map((ns) =>
          dnsPromises.resolve4(ns).catch(() => [] as string[]),
        ),
      );
      servers = addresses.flat();
    } catch (err) {
      this.logger.warn(
        `Cannot resolve authoritative NS for ${zoneName} (${err instanceof Error ? err.message : String(err)}) — skipping DNS propagation gate`,
      );
      return true;
    }
    if (servers.length === 0) return true;

    const resolver = new dnsPromises.Resolver({ timeout: 3000, tries: 1 });
    resolver.setServers(servers);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const answers = await resolver.resolve4(fqdn);
        if (answers.includes(expectedValue) || answers.length > 0) {
          return true;
        }
      } catch (err) {
        // Name exists but has no A record (e.g. CNAME): no NXDOMAIN to cache.
        if ((err as NodeJS.ErrnoException)?.code === 'ENODATA') return true;
        // ENOTFOUND (NXDOMAIN) or query timeout: not propagated yet.
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    this.logger.warn(
      `DNS record for ${fqdn} not visible on authoritative NS of ${zoneName} after ${timeoutMs}ms`,
    );
    return false;
  }

  private async reconcileDnsRecord(
    endpoint: AppEndpointEntity,
    clusterDnsZone: ClusterDnsZoneEntity,
    cluster: ClusterEntity,
  ): Promise<DnsRecordInfo> {
    const dnsZone = clusterDnsZone.dnsZone;
    const recordValue = endpoint.dnsRecordValue ?? cluster.masterIpAddress;
    if (!recordValue) {
      throw new Error(
        `Cannot create DNS record for endpoint ${endpoint.id}: no IP address available. ` +
          `Make sure the cluster has a master IP address or provide dnsRecordValue explicitly.`,
      );
    }

    const recordName = resolveRecordName(endpoint.fqdn, dnsZone.zoneName);
    const ttl = dnsZone.recordTtlSeconds;

    // A wildcard the zone already publishes answers for this name today, with
    // no propagation to wait for. Writing a per-app record next to it would be
    // a second way of saying the same thing, and the *slow* way: a brand new
    // name takes about a minute to become resolvable, and that minute is spent
    // on the one screen that matters — the link to the application.
    const covered = await this.wildcardCoveringRecord(
      dnsZone,
      recordName,
      endpoint.dnsRecordType,
      recordValue,
    );
    if (covered) {
      this.logger.log(
        `${endpoint.fqdn} is already covered by ${covered.name} in ${dnsZone.zoneName} → ${covered.value} — no per-app record needed`,
      );
      // Deliberately without the wildcard's own id: this endpoint does not own
      // that record, and teardown deletes what an endpoint owns.
      return { ...covered, recordId: '' };
    }

    const primary = await this.writePrimaryRecord(
      endpoint,
      dnsZone,
      cluster,
      recordName,
      recordValue,
      ttl,
    );

    // Publish the same record to any redundancy replicas (best-effort, never throws).
    await this.dnsZoneReconciliationService.fanOutRecordToReplicas(dnsZone, {
      name: recordName,
      type: endpoint.dnsRecordType,
      value: recordValue,
      ttl,
    });

    return primary;
  }

  private async writePrimaryRecord(
    endpoint: AppEndpointEntity,
    dnsZone: DnsZoneEntity,
    cluster: ClusterEntity,
    recordName: string,
    recordValue: string,
    ttl: number,
  ): Promise<DnsRecordInfo> {
    const dnsProvider = this.dnsProviderFactory.getDnsProviderOrFail(
      dnsZone.dnsProvider,
    );

    const labels = {
      'managed-by': 'flui-cloud',
      'flui-resource-type': 'dns-record',
      'flui-cluster-id': cluster.id,
      [ENDPOINT_ID_LABEL]: endpoint.id,
    };

    // By id when we have one, else by name+type: destroying a cluster cascades
    // dnsRecordId away, and createRecord *appends* to an existing RRSet, so a
    // blind create would leave the dead cluster's IP answering alongside the new
    // one. Adopting re-points it instead.
    const existing =
      (endpoint.dnsRecordId
        ? await dnsProvider.getRecord(
            dnsZone.providerZoneId,
            endpoint.dnsRecordId,
          )
        : null) ??
      (await this.findRecordByNameType(
        dnsProvider,
        dnsZone,
        recordName,
        endpoint.dnsRecordType,
      ));

    if (existing) {
      if (existing.value === recordValue) {
        return existing;
      }
      this.logger.log(
        `Repointing DNS record ${existing.recordId} for ${endpoint.fqdn}: ${existing.value} → ${recordValue}`,
      );
      return await dnsProvider.updateRecord({
        recordId: existing.recordId,
        zoneId: dnsZone.providerZoneId,
        type: endpoint.dnsRecordType,
        name: recordName,
        value: recordValue,
        ttl,
        labels,
      });
    }

    this.logger.log(
      `Creating DNS record for ${endpoint.fqdn} → ${recordValue}`,
    );
    return await dnsProvider.createRecord({
      zoneId: dnsZone.providerZoneId,
      type: endpoint.dnsRecordType,
      name: recordName,
      value: recordValue,
      ttl,
      labels,
    });
  }

  /** Best-effort: a provider that can't list records falls back to creating. */
  /**
   * The zone's own wildcard, when it already answers for this name with exactly
   * the value we would have written.
   *
   * Two conditions, and both matter. **One label**, because that is all a DNS
   * wildcard matches: `*.control-cluster` answers for `app.control-cluster` and
   * not for `a.b.control-cluster`. **The same value**, because a wildcard
   * pointing somewhere else is not coverage — it is a different answer, and
   * skipping the per-app record then would send the application's visitors to
   * the wrong host. When both hold, the per-app record is redundant by
   * construction: with it or without it, the name resolves to the same address.
   *
   * Nothing to configure. Publish the wildcard on the zone and Flui stops
   * writing per-app records; remove it and they come back on the next
   * reconcile.
   */
  private async wildcardCoveringRecord(
    dnsZone: DnsZoneEntity,
    recordName: string,
    recordType: DnsRecordType,
    recordValue: string,
  ): Promise<DnsRecordInfo | null> {
    // `*.example.com` answers for `www.example.com` and never for
    // `example.com` itself. The apex has no wildcard that can cover it.
    if (recordName === '@') return null;

    const labels = recordName.split('.');
    const wildcardName = ['*', ...labels.slice(1)].join('.');

    try {
      const dnsProvider = this.dnsProviderFactory.getDnsProviderOrFail(
        dnsZone.dnsProvider,
      );
      const records = await dnsProvider.listRecords(dnsZone.providerZoneId);
      return (
        records.find(
          (r) =>
            r.name === wildcardName &&
            r.type === recordType &&
            r.value === recordValue,
        ) ?? null
      );
    } catch (error) {
      // A provider we cannot read is not a zone without a wildcard, but the
      // safe assumption is the one that still publishes a working name.
      this.logger.warn(
        `Could not check ${dnsZone.zoneName} for a wildcard covering ${recordName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async findRecordByNameType(
    dnsProvider: IDnsProvider,
    dnsZone: DnsZoneEntity,
    recordName: string,
    recordType: DnsRecordType,
  ): Promise<DnsRecordInfo | null> {
    try {
      const records = await dnsProvider.listRecords(dnsZone.providerZoneId);
      const matches = records.filter(
        (r) => r.name === recordName && r.type === recordType,
      );
      if (matches.length > 1) {
        // Warn, don't purge: a stale leftover and a deliberate round-robin look
        // identical from here.
        this.logger.warn(
          `${recordName} (${recordType}) in zone ${dnsZone.zoneName} resolves to ${matches.length} values ` +
            `(${matches.map((r) => r.value).join(', ')}) — adopting ${matches[0].value}; ` +
            `remove any that no longer belong to a live cluster`,
        );
      }
      return matches[0] ?? null;
    } catch (error) {
      this.logger.warn(
        `Could not list records in zone ${dnsZone.zoneName} to adopt ${recordName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
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
          [ENDPOINT_ID_LABEL]: endpoint.id,
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

  /**
   * Traefik entrypoints for the Ingress. `websecure` is always bound, with or
   * without an issued certificate, for two reasons that point the same way:
   *
   * - Flui publishes every endpoint as `https://…`, so binding only `web` makes
   *   the link Flui itself hands out answer 404 while the app is in fact serving.
   * - An internal endpoint's ForwardAuth session cookie must never cross plain
   *   HTTP, and without a certificate that is exactly where it would travel.
   *
   * Uncertificated, Traefik answers with its default self-signed certificate: a
   * browser warning, which is both survivable and an accurate signal that TLS is
   * not ready yet. Internal endpoints drop `web` entirely — they have no ACME
   * HTTP-01 challenge to serve, so plaintext buys them nothing.
   */
  private entrypointsFor(isInternal: boolean, hasTls: boolean): string {
    return isInternal && !hasTls ? 'websecure' : 'web,websecure';
  }

  private async reconcileIngress(
    endpoint: AppEndpointEntity,
    clusterDnsZone: ClusterDnsZoneEntity | null,
    cluster: ClusterEntity,
    effectiveCertProvider?: CertificateProvider,
  ): Promise<void> {
    const kubeconfig = await this.getKubeconfig(cluster);
    const ingressName = this.ingressNameFor(endpoint);

    await this.cleanupStaleHostResources(kubeconfig, endpoint, ingressName);

    const { hasCert, usesSharedSecret, tlsSecretName, issuerName } =
      this.resolveIngressTlsContext(endpoint, effectiveCertProvider);

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

    const gateway = await this.reconcileGatewayMiddlewares(
      kubeconfig,
      endpoint,
    );
    const noindexMiddlewareRef =
      await this.sandboxNoindexMiddlewareRef(endpoint);
    const middlewareRefs = [
      ...(traefikMiddlewareRef ? [traefikMiddlewareRef] : []),
      ...(noindexMiddlewareRef ? [noindexMiddlewareRef] : []),
      ...gateway.refs,
    ];

    const manifest: Record<string, unknown> = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: ingressName,
        namespace: endpoint.k8sNamespace,
        annotations: {
          'traefik.ingress.kubernetes.io/router.entrypoints':
            this.entrypointsFor(isInternal, hasCert || usesSharedSecret),
          ...(hasCert && !usesSharedSecret
            ? { 'cert-manager.io/cluster-issuer': issuerName }
            : {}),
          ...(middlewareRefs.length
            ? {
                'traefik.ingress.kubernetes.io/router.middlewares':
                  middlewareRefs.join(','),
              }
            : {}),
        },
        labels: {
          'managed-by': 'flui-cloud',
          'flui-cluster-id': cluster.id,
          'flui-resource-type': 'dns-ingress',
          [ENDPOINT_ID_LABEL]: endpoint.id,
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
                  path: gateway.path,
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

    await this.deleteLegacyIngressIfOwned(kubeconfig, endpoint);
  }

  private async sandboxNoindexMiddlewareRef(
    endpoint: AppEndpointEntity,
  ): Promise<string | null> {
    const sandbox = await this.sandboxTenants.exists({
      where: {
        clusterId: endpoint.clusterId,
        namespace: endpoint.k8sNamespace,
      },
    });
    return sandbox ? sandboxNoindexMiddlewareRef(endpoint.k8sNamespace) : null;
  }

  /**
   * Ingress name is unique per endpoint (id suffix) so multiple endpoints on
   * the same service (e.g. apex + www) never overwrite each other's Ingress,
   * and stable across fqdn edits so the stale-host cleanup keeps working.
   */
  private ingressNameFor(endpoint: AppEndpointEntity): string {
    return `${endpoint.k8sServiceName}-${endpoint.id.split('-')[0]}-ingress`;
  }

  /**
   * If the existing Ingress points to a different host (fqdn changed),
   * clean up the stale TLS secret and Certificate before reapplying.
   */
  private async cleanupStaleHostResources(
    kubeconfig: string,
    endpoint: AppEndpointEntity,
    ingressName: string,
  ): Promise<void> {
    const existingIngress = await this.kubernetesService.getResource(
      kubeconfig,
      'Ingress',
      ingressName,
      endpoint.k8sNamespace,
    );
    const existingHost: string | undefined =
      existingIngress?.spec?.rules?.[0]?.host;
    if (!existingHost || existingHost === endpoint.fqdn) return;

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

  private resolveIngressTlsContext(
    endpoint: AppEndpointEntity,
    effectiveCertProvider?: CertificateProvider,
  ): {
    hasCert: boolean;
    usesSharedSecret: boolean;
    tlsSecretName: string;
    issuerName: string;
  } {
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

    let issuerName = 'letsencrypt-production';
    if (effectiveCertProvider) {
      const useDns01 =
        endpoint.certChallenge === CertChallenge.DNS_01 ||
        endpoint.fqdn.startsWith('*.');
      const acmeUrl = this.acmeCertificateService.getAcmeServerUrl(
        effectiveCertProvider,
      );
      issuerName = useDns01
        ? this.acmeCertificateService.getWildcardIssuerName(acmeUrl)
        : this.acmeCertificateService.getIssuerName(acmeUrl);
    }

    return { hasCert, usesSharedSecret, tlsSecretName, issuerName };
  }

  /**
   * Apply the gateway-policy Middlewares for this endpoint and delete the ones
   * no longer configured. Fail-closed on SSO: when the config asks for SSO but
   * no forwardAuth address is discoverable, the whole reconcile aborts rather
   * than exposing the route without the auth gate.
   */
  private async reconcileGatewayMiddlewares(
    kubeconfig: string,
    endpoint: AppEndpointEntity,
  ): Promise<{ refs: string[]; path: string }> {
    const config = endpoint.gatewayConfig;

    let forwardAuthAddress: string | undefined;
    if (config?.auth?.sso) {
      forwardAuthAddress = this.resolveGatewayForwardAuthAddress();
      if (!forwardAuthAddress) {
        throw new Error(
          `Refusing to apply Ingress for endpoint ${endpoint.id} (${endpoint.fqdn}): gateway SSO is enabled but no Flui API public URL is discoverable (PUBLIC_API_URL / FLUI_API_ENDPOINT / API_BASE_URL). Failing closed so the route is NOT exposed without its auth gate.`,
        );
      }
    }

    const compiled = this.gatewayCompiler.compile(
      endpoint,
      config,
      forwardAuthAddress,
    );

    for (const middleware of compiled.middlewares) {
      await this.kubernetesService.applyManifest(
        kubeconfig,
        JSON.stringify(middleware.manifest),
      );
    }

    const desired = new Set(compiled.middlewares.map((m) => m.name));
    await this.deleteGatewayMiddlewares(kubeconfig, endpoint, desired);

    if (compiled.middlewares.length) {
      this.logger.log(
        `Applied ${compiled.middlewares.length} gateway middleware(s) for ${endpoint.fqdn}: ${[...desired].join(', ')}`,
      );
    }

    return { refs: compiled.refs, path: compiled.path };
  }

  /** Delete this endpoint's gateway Middlewares, except the ones in `keep`. */
  private async deleteGatewayMiddlewares(
    kubeconfig: string,
    endpoint: AppEndpointEntity,
    keep?: Set<string>,
  ): Promise<void> {
    for (const name of this.gatewayCompiler.allMiddlewareNames(endpoint)) {
      if (keep?.has(name)) continue;
      try {
        await this.kubernetesService.deleteResource(
          kubeconfig,
          'Middleware',
          name,
          endpoint.k8sNamespace,
        );
      } catch (err) {
        this.logger.warn(
          `Gateway middleware delete skipped for ${endpoint.k8sNamespace}/${name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private resolveGatewayForwardAuthAddress(): string | undefined {
    let fluiApiUrl =
      process.env.PUBLIC_API_URL ||
      process.env.FLUI_API_ENDPOINT ||
      process.env.API_BASE_URL ||
      process.env.WEBHOOK_BASE_URL ||
      '';
    while (fluiApiUrl.endsWith('/')) fluiApiUrl = fluiApiUrl.slice(0, -1);
    return fluiApiUrl ? `${fluiApiUrl}/api/v1/authz/gateway` : undefined;
  }

  /**
   * Pre-multi-endpoint releases named the Ingress `<service>-ingress`, shared
   * by every endpoint of the service. Remove it only when its host belongs to
   * this endpoint: the sibling endpoint still routed by the legacy Ingress
   * keeps working until its own reconcile migrates it.
   */
  private async deleteLegacyIngressIfOwned(
    kubeconfig: string,
    endpoint: AppEndpointEntity,
  ): Promise<void> {
    const legacyName = `${endpoint.k8sServiceName}-ingress`;
    try {
      const legacy = await this.kubernetesService.getResource(
        kubeconfig,
        'Ingress',
        legacyName,
        endpoint.k8sNamespace,
      );
      const legacyHost: string | undefined = legacy?.spec?.rules?.[0]?.host;
      if (legacy && (!legacyHost || legacyHost === endpoint.fqdn)) {
        await this.kubernetesService.deleteResource(
          kubeconfig,
          'Ingress',
          legacyName,
          endpoint.k8sNamespace,
        );
        this.logger.log(
          `Deleted legacy Ingress ${legacyName} (superseded by per-endpoint Ingress)`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Legacy Ingress cleanup failed for ${legacyName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
