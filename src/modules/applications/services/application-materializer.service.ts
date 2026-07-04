import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationEnvVar } from '../interfaces/source-config.interface';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { GhcrSecretRefreshService } from './ghcr-secret-refresh.service';

const WAITABLE_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
const MATERIALIZE_READINESS_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Non-persisted overrides applied to an in-memory clone of the app before
 * manifest generation — lets a migration stage a workload (e.g. replicas: 0,
 * or the rewired destination env for variant-B live-fenced staging) without
 * mutating the ApplicationEntity. `env` values are already single-encrypted
 * (the rewire plan), so the generator's decrypt-once render stays correct.
 */
export interface MaterializeOverrides {
  replicas?: number;
  env?: ApplicationEnvVar[];
}

/**
 * Stands an application's workload up on an arbitrary cluster **without**
 * mutating the `ApplicationEntity` — the pre-cutover materialization the
 * app-migration machine runs against the destination. Because manifests are
 * cluster-agnostic (K8s object names derive from the slug, the env Secret is
 * decrypted control-plane-side, the GHCR pull secret re-materializes per
 * cluster) the same stored state reproduces the workload on any cluster. The
 * OIDC client (FQDN-keyed, global) and DNS are the caller's concern.
 */
@Injectable()
export class ApplicationMaterializerService {
  private readonly logger = new Logger(ApplicationMaterializerService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly manifestGenerator: ApplicationManifestGeneratorService,
    private readonly ghcrSecretRefresh: GhcrSecretRefreshService,
  ) {}

  private async kubeconfigFor(clusterId: string): Promise<string> {
    const cluster = await this.clusterRepo.findOne({
      where: { id: clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new Error(`Cluster ${clusterId} not found or kubeconfig missing`);
    }
    return this.encryptionService.decrypt(cluster.kubeconfigEncrypted);
  }

  /**
   * Apply the app's workload manifests to `targetClusterId` and wait for the
   * workload to become Ready. Server-side apply → idempotent (safe to re-run).
   * Does not create/repoint endpoints or DNS.
   */
  async materializeOnCluster(
    app: ApplicationEntity,
    targetClusterId: string,
    overrides?: MaterializeOverrides,
  ): Promise<void> {
    const kubeconfig = await this.kubeconfigFor(targetClusterId);
    // In-memory clone so overrides (e.g. staging at replicas 0) never touch the
    // persisted entity; the generator only reads fields.
    const effectiveApp =
      overrides?.replicas === undefined && overrides?.env === undefined
        ? app
        : ({
            ...app,
            ...(overrides?.replicas === undefined
              ? {}
              : { replicas: overrides.replicas }),
            ...(overrides?.env === undefined ? {} : { env: overrides.env }),
          } as ApplicationEntity);

    await this.kubernetesService.ensureNamespaceExists(
      kubeconfig,
      app.k8sNamespace,
      {
        'flui.cloud/tier': 'user',
        ...(app.userId ? { 'flui.cloud/owner': app.userId } : {}),
      },
    );

    let imagePullSecretName: string | undefined;
    if (app.sourceType === ApplicationSourceType.GIT_BUILD && app.userId) {
      imagePullSecretName = await this.ghcrSecretRefresh.ensureSecretForApp(
        kubeconfig,
        app,
      );
      // GIT_BUILD images are private (ghcr.io) — without the pull secret the
      // pods would sit in ImagePullBackOff until the readiness timeout. Fail
      // fast with the real cause instead.
      if (!imagePullSecretName) {
        throw new Error(
          `Failed to create the GHCR pull secret on the destination cluster for ${app.slug} — cannot materialize a private image without it`,
        );
      }
    }

    const manifests = this.manifestGenerator.generateForDockerImage(
      effectiveApp,
      imagePullSecretName,
    );
    for (const m of manifests) {
      await this.kubernetesService.applyManifest(kubeconfig, m.yaml);
    }

    for (const m of manifests) {
      if (WAITABLE_KINDS.has(m.kind)) {
        this.logger.log(
          `[materialize] ${app.slug}: waiting for ${m.kind}/${m.name} on cluster ${targetClusterId}`,
        );
        await this.kubernetesService.waitForReady(
          kubeconfig,
          m.kind,
          m.name,
          app.k8sNamespace,
          MATERIALIZE_READINESS_TIMEOUT_MS,
        );
      }
    }
    this.logger.log(
      `[materialize] ${app.slug}: ${manifests.length} manifests applied + ready on cluster ${targetClusterId}`,
    );
  }

  /**
   * Tear the app's workload down on a cluster (abort rollback of the
   * destination, or DESTROY of the drained source). Best-effort per resource;
   * names derive from the generated manifests, so no live cluster read needed.
   */
  async teardownOnCluster(
    app: ApplicationEntity,
    clusterId: string,
  ): Promise<void> {
    const kubeconfig = await this.kubeconfigFor(clusterId);
    const manifests = this.manifestGenerator.generateForDockerImage(app);
    for (const m of manifests) {
      await this.kubernetesService
        .deleteResource(kubeconfig, m.kind, m.name, app.k8sNamespace)
        .catch((err: unknown) =>
          this.logger.warn(
            `[teardown] ${app.slug}: delete ${m.kind}/${m.name} on ${clusterId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    }
  }
}
