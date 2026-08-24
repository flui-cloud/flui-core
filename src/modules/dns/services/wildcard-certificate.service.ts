import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WildcardCertificateEntity } from '../entities/wildcard-certificate.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ClusterDnsZoneService } from './cluster-dns-zone.service';
import { AcmeCertificateService } from '../../providers/services/acme-certificate.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { WildcardCertificateConfigService } from './wildcard-certificate-config.service';
import { ReflectorInstallerService } from './reflector-installer.service';
import { DnsProviderFactory } from '../../providers/services/dns-provider.factory';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';

export interface EnsureWildcardResult {
  wildcardCertificateId: string;
  tlsSecretName: string;
  ready: boolean;
}

@Injectable()
export class WildcardCertificateService {
  private readonly logger = new Logger(WildcardCertificateService.name);
  private static readonly MASTER_READY_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(
    @InjectRepository(WildcardCertificateEntity)
    private readonly repository: Repository<WildcardCertificateEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
    private readonly acmeCertificateService: AcmeCertificateService,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly config: WildcardCertificateConfigService,
    private readonly reflectorInstaller: ReflectorInstallerService,
    private readonly dnsProviderFactory: DnsProviderFactory,
  ) {}

  isEnabled(): boolean {
    return this.config.isEnabled();
  }

  /**
   * Resolves the wildcard scope that covers `fqdn` under the cluster's root
   * zone: the scope is `fqdn` minus its first label. The scope must fall
   * within the managed zone (or equal it). Returns null when the fqdn is the
   * apex, is outside the zone, or has no parent label to wildcard over.
   *
   * Examples (root zone = "flui.cloud"):
   *   memos.flui.cloud            -> "flui.cloud"
   *   app.local.flui.cloud        -> "local.flui.cloud"
   *   deep.app.local.flui.cloud   -> "app.local.flui.cloud"
   *   flui.cloud (apex)           -> null
   *   foo.bar.example.com         -> null (outside zone)
   */
  resolveScope(fqdn: string, rootZone: string): string | null {
    const normalized = fqdn.trim().toLowerCase();
    const zone = rootZone.trim().toLowerCase();
    if (!normalized || !zone) return null;
    if (normalized === zone) return null;
    if (!normalized.endsWith(`.${zone}`)) return null;
    const firstDot = normalized.indexOf('.');
    if (firstDot < 0) return null;
    const scope = normalized.slice(firstDot + 1);
    if (scope !== zone && !scope.endsWith(`.${zone}`)) return null;
    return scope;
  }

  /**
   * Ensures a wildcard certificate exists for the scope derived from `fqdn`
   * under the cluster's zone, and a TLS Secret is available in
   * `targetNamespace`. Returns null when the feature flag is off, when the
   * fqdn is not covered by any wildcard (apex, outside zone), or when no
   * wildcard ClusterIssuer is ready — callers must fall back to per-host.
   */
  async ensureForEndpoint(
    clusterId: string,
    fqdn: string,
    targetNamespace: string,
  ): Promise<EnsureWildcardResult | null> {
    if (!this.config.isEnabled()) {
      return null;
    }

    const assignment = await this.clusterDnsZoneService.getZoneForFqdn(
      clusterId,
      fqdn,
    );
    if (!assignment) {
      this.logger.log(
        `[wildcard] fqdn="${fqdn}" not covered by any zone assigned to cluster ${clusterId} — delegating to per-host`,
      );
      return null;
    }
    const zoneName = assignment.dnsZone?.zoneName;
    if (!zoneName) {
      throw new BadRequestException(
        `Cluster ${clusterId} DNS zone assignment ${assignment.id} has no zoneName`,
      );
    }

    const scope = this.resolveScope(fqdn, zoneName);
    if (!scope) {
      this.logger.log(
        `[wildcard] fqdn="${fqdn}" not covered by any wildcard under zone "${zoneName}" — delegating to per-host`,
      );
      return null;
    }

    return await this.ensureForScope(clusterId, scope, targetNamespace);
  }

  /**
   * The same work, asked for by scope rather than derived from a hostname:
   * ensure `*.<scope>` exists and its Secret is available in `targetNamespace`.
   *
   * A caller that already knows the scope has one thing `ensureForEndpoint`
   * cannot have — it can ask *before* any name under that scope exists. That is
   * the only way a wildcard is ready when the first application arrives instead
   * of minutes after it, and a certificate that arrives after the link does is
   * a certificate the person never sees working.
   *
   * Returns null on the same terms as the endpoint entry point: feature off, no
   * zone covering the scope, or nothing to wildcard over. A null is "use
   * per-host", never "this failed".
   */
  async ensureForScope(
    clusterId: string,
    scope: string,
    targetNamespace: string,
  ): Promise<EnsureWildcardResult | null> {
    if (!this.config.isEnabled()) {
      return null;
    }

    const normalizedScope = scope.trim().toLowerCase();
    if (!normalizedScope) return null;

    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const assignment = await this.clusterDnsZoneService.getZoneForFqdn(
      clusterId,
      normalizedScope,
    );
    if (!assignment) {
      this.logger.log(
        `[wildcard] scope="${normalizedScope}" not covered by any zone assigned to cluster ${clusterId} — delegating to per-host`,
      );
      return null;
    }
    const zoneName = assignment.dnsZone?.zoneName;
    if (!zoneName) {
      throw new BadRequestException(
        `Cluster ${clusterId} DNS zone assignment ${assignment.id} has no zoneName`,
      );
    }

    const issuer =
      await this.clusterDnsZoneService.resolveWildcardIssuer(clusterId);
    if (!issuer) {
      throw new BadRequestException(
        `Cluster ${clusterId} has no ready wildcard ClusterIssuer. ` +
          `Configure the DNS-01 issuer before enabling wildcard certificates.`,
      );
    }

    const entity = await this.upsertEntity({
      clusterId,
      dnsZoneId: assignment.dnsZoneId,
      scope: normalizedScope,
      issuerName: issuer.issuerName,
      certificateProvider: issuer.certificateProvider,
    });

    const kubeconfig = await this.getKubeconfig(cluster);

    await this.reflectorInstaller.ensureInstalled(kubeconfig);
    await this.cleanupStaleAcmeTxt(assignment.dnsZone, normalizedScope);
    await this.applyMasterCertificate(entity, kubeconfig);
    const ready = await this.waitMasterSecretReady(entity, kubeconfig);
    await this.ensureDistribution(entity, targetNamespace, kubeconfig);

    const refreshed = await this.repository.save({
      ...entity,
      status: ready ? CertificateStatus.VALID : CertificateStatus.ISSUING,
      reconciliationStatus: ready
        ? ReconciliationStatus.IN_SYNC
        : ReconciliationStatus.RECONCILING,
      lastReconciliationAt: new Date(),
      errorMessage: null,
    });

    return {
      wildcardCertificateId: refreshed.id,
      tlsSecretName: refreshed.masterSecretName,
      ready,
    };
  }

  async getByClusterId(
    clusterId: string,
  ): Promise<WildcardCertificateEntity[]> {
    return await this.repository.find({ where: { clusterId } });
  }

  async getById(id: string): Promise<WildcardCertificateEntity | null> {
    return await this.repository.findOne({ where: { id } });
  }

  /** The row for `*.<scope>` on this cluster, or null when none was ever asked for. */
  async getByScope(
    clusterId: string,
    scope: string,
  ): Promise<WildcardCertificateEntity | null> {
    return await this.repository.findOne({
      where: { clusterId, scope: scope.trim().toLowerCase() },
    });
  }

  /**
   * Take `*.<scope>` away: the Certificate and its Secret on the cluster, then
   * the row. Best-effort on the cluster half — a certificate whose scope no
   * longer exists is worth removing even from a cluster we cannot reach, and
   * leaving the row would keep it out of the next issuance's way for nothing.
   *
   * The master Secret lives in `flui-system`, so deleting the namespace a
   * tenancy lived in does *not* take it with it. Nothing else would.
   */
  async deleteForScope(clusterId: string, scope: string): Promise<boolean> {
    const entity = await this.getByScope(clusterId, scope);
    if (!entity) return false;

    try {
      const cluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
      });
      if (cluster?.kubeconfigEncrypted) {
        const kubeconfig = await this.getKubeconfig(cluster);
        await this.kubernetesService.deleteResource(
          kubeconfig,
          'Certificate',
          entity.masterCertName,
          entity.masterNamespace,
        );
        await this.kubernetesService.deleteResource(
          kubeconfig,
          'Secret',
          entity.masterSecretName,
          entity.masterNamespace,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to delete wildcard Certificate/Secret for scope ${entity.scope}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.repository.delete(entity.id);
    return true;
  }

  private async upsertEntity(input: {
    clusterId: string;
    dnsZoneId: string;
    scope: string;
    issuerName: string;
    certificateProvider: WildcardCertificateEntity['certificateProvider'];
  }): Promise<WildcardCertificateEntity> {
    const existing = await this.repository.findOne({
      where: { clusterId: input.clusterId, scope: input.scope },
    });

    const masterCertName = this.buildMasterName(input.scope);
    const masterSecretName = `${masterCertName}-tls`;
    const masterNamespace = this.config.getMasterNamespace();

    if (existing) {
      existing.dnsZoneId = input.dnsZoneId;
      existing.issuerName = input.issuerName;
      existing.certificateProvider = input.certificateProvider;
      existing.masterNamespace = masterNamespace;
      existing.masterCertName = masterCertName;
      existing.masterSecretName = masterSecretName;
      return await this.repository.save(existing);
    }

    const entity = this.repository.create({
      clusterId: input.clusterId,
      dnsZoneId: input.dnsZoneId,
      scope: input.scope,
      masterNamespace,
      masterCertName,
      masterSecretName,
      issuerName: input.issuerName,
      certificateProvider: input.certificateProvider,
      status: CertificateStatus.PENDING,
      reconciliationStatus: ReconciliationStatus.PENDING,
    });
    return await this.repository.save(entity);
  }

  private buildMasterName(scope: string): string {
    const slug = scope.replaceAll('.', '-').toLowerCase();
    return `wildcard-${slug}`;
  }

  private async applyMasterCertificate(
    entity: WildcardCertificateEntity,
    kubeconfig: string,
  ): Promise<void> {
    await this.ensureNamespace(entity.masterNamespace, kubeconfig);

    const manifest =
      this.acmeCertificateService.generateWildcardCertificateManifest({
        name: entity.masterCertName,
        namespace: entity.masterNamespace,
        secretName: entity.masterSecretName,
        issuerName: entity.issuerName,
        zoneName: entity.scope,
      });
    await this.kubernetesService.applyManifest(kubeconfig, manifest);
    this.logger.log(
      `Applied wildcard Certificate ${entity.masterNamespace}/${entity.masterCertName} for *.${entity.scope}`,
    );
  }

  private async ensureNamespace(
    namespace: string,
    kubeconfig: string,
  ): Promise<void> {
    const manifest = [
      'apiVersion: v1',
      'kind: Namespace',
      'metadata:',
      `  name: ${namespace}`,
      '  labels:',
      '    managed-by: flui-cloud',
      '',
    ].join('\n');
    await this.kubernetesService.applyManifest(kubeconfig, manifest);
  }

  private async waitMasterSecretReady(
    entity: WildcardCertificateEntity,
    kubeconfig: string,
  ): Promise<boolean> {
    try {
      await this.kubernetesService.waitForSecret(
        kubeconfig,
        entity.masterSecretName,
        entity.masterNamespace,
        WildcardCertificateService.MASTER_READY_TIMEOUT_MS,
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Master Secret ${entity.masterNamespace}/${entity.masterSecretName} not ready: ${message}`,
      );
      return false;
    }
  }

  /**
   * Materializes the wildcard TLS Secret in `targetNamespace`. We copy the
   * tls.crt / tls.key bytes directly from the master Secret in `flui-system`
   * so the cert is usable immediately, AND set the kubernetes-reflector
   * annotation so renewals propagate without a reconciliation. If a Secret
   * with the same name already exists but does not match the master content
   * (e.g. a stale per-host cert leaked into the wildcard slot), it is
   * overwritten — fail-loud cleanup beats silently serving the wrong cert.
   */
  private async ensureDistribution(
    entity: WildcardCertificateEntity,
    targetNamespace: string,
    kubeconfig: string,
  ): Promise<void> {
    if (targetNamespace === entity.masterNamespace) {
      return;
    }

    const master = await this.kubernetesService.getResource(
      kubeconfig,
      'Secret',
      entity.masterSecretName,
      entity.masterNamespace,
    );
    const masterBody = master?.body ?? master;
    const masterData = masterBody?.data ?? {};
    const masterCrt = masterData['tls.crt'];
    const masterKey = masterData['tls.key'];
    if (!masterCrt || !masterKey) {
      this.logger.warn(
        `Master wildcard Secret ${entity.masterNamespace}/${entity.masterSecretName} not yet populated — skipping distribution; reflector will sync once issued`,
      );
      return;
    }

    const reflectsValue = `${entity.masterNamespace}/${entity.masterSecretName}`;
    const existing = await this.kubernetesService.getResource(
      kubeconfig,
      'Secret',
      entity.masterSecretName,
      targetNamespace,
    );
    const existingBody = existing?.body ?? existing;
    const existingData = existingBody?.data ?? {};
    const existingReflects =
      existingBody?.metadata?.annotations?.[
        'reflector.v1.k8s.emberstack.com/reflects'
      ];

    const inSync =
      existing &&
      existingData['tls.crt'] === masterCrt &&
      existingData['tls.key'] === masterKey &&
      existingReflects === reflectsValue;
    if (inSync) {
      this.logger.log(
        `Wildcard Secret replica ${targetNamespace}/${entity.masterSecretName} already in sync with master`,
      );
      return;
    }

    if (existing && existingReflects !== reflectsValue) {
      this.logger.warn(
        `Replacing stale Secret ${targetNamespace}/${entity.masterSecretName} (reflects=${existingReflects ?? 'none'}) with wildcard replica`,
      );
      await this.kubernetesService.deleteResource(
        kubeconfig,
        'Secret',
        entity.masterSecretName,
        targetNamespace,
      );
    }

    const manifest = [
      'apiVersion: v1',
      'kind: Secret',
      'type: kubernetes.io/tls',
      'metadata:',
      `  name: ${entity.masterSecretName}`,
      `  namespace: ${targetNamespace}`,
      '  labels:',
      '    managed-by: flui-cloud',
      '    flui-resource-type: wildcard-certificate-replica',
      '  annotations:',
      `    reflector.v1.k8s.emberstack.com/reflects: "${reflectsValue}"`,
      'data:',
      `  tls.crt: ${masterCrt}`,
      `  tls.key: ${masterKey}`,
      '',
    ].join('\n');

    await this.kubernetesService.applyManifest(kubeconfig, manifest);
    this.logger.log(
      `Materialized wildcard Secret replica ${targetNamespace}/${entity.masterSecretName} (reflects ${reflectsValue})`,
    );
  }

  /**
   * Removes stale `_acme-challenge.<zone>` TXT records from the DNS zone
   * before cert-manager runs a new DNS-01 challenge. The community Hetzner
   * webhook is not idempotent: if a prior Present() call timed out after
   * writing the record, the next retry fails with "duplicate value" and the
   * challenge gets stuck in `pending`. Pre-clearing is cheap and only
   * affects records created by the solver (which are transient by design).
   */
  private async cleanupStaleAcmeTxt(
    dnsZone: WildcardCertificateEntity['dnsZone'],
    scope: string,
  ): Promise<void> {
    try {
      const dnsProvider = this.dnsProviderFactory.getDnsProviderOrFail(
        dnsZone.dnsProvider,
      );
      const records = await dnsProvider.listRecords(dnsZone.providerZoneId);
      const acmeLabel = '_acme-challenge';
      const rootZone = dnsZone.zoneName.toLowerCase();
      const relativeName =
        scope === rootZone
          ? acmeLabel
          : `${acmeLabel}.${scope.slice(0, -(rootZone.length + 1))}`;
      const absoluteName = `${acmeLabel}.${scope}`;
      const stale = records.filter(
        (r) =>
          r.type === DnsRecordType.TXT &&
          (r.name === relativeName || r.name === absoluteName),
      );
      if (stale.length === 0) return;

      this.logger.log(
        `Cleaning up ${stale.length} stale ACME TXT record(s) for scope ${scope}`,
      );
      for (const record of stale) {
        try {
          await dnsProvider.deleteRecord(
            dnsZone.providerZoneId,
            record.recordId,
          );
        } catch (err) {
          this.logger.warn(
            `Failed to delete stale TXT ${record.recordId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Stale ACME TXT cleanup failed for scope ${scope}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
}
