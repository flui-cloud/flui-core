import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Readable } from 'node:stream';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  POOLER_OF_LABEL,
  POOLER_SERVICE_PORT,
  PoolerMode,
  PoolerSpec,
  assertPgbouncerName,
  ensurePoolerRoleScript,
  pgbouncerImage,
  poolerHostOf,
  poolerManifestsToApply,
  poolerNames,
  postgresIdentity,
} from '../../applications/utils/db-pooler.core';
import { BlockConnectionUrlService } from './block-connection-url.service';
import { CatalogSecretGeneratorService } from './catalog-secret-generator.service';
import { DbPoolerStatusDto } from '../dto/db-pooler-status.dto';
import { ApplicationManifestGeneratorService } from '../../applications/services/application-manifest-generator.service';
import { ApplicationResourceKind } from '../../applications/enums/application-resource-kind.enum';
import { applyAppManifest } from '../../applications/utils/app-manifest-scope';

const POOLER_READY_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * The connection pooler of a managed PostgreSQL, from the API side: the role
 * PgBouncer looks clients up with, the wait for the pooler to answer, and the
 * move of the connection URL onto it. The objects themselves are rendered by
 * the manifest generator and applied with every deploy of the database.
 */
@Injectable()
export class DbPoolerService {
  private readonly logger = new Logger(DbPoolerService.name);

  constructor(
    private readonly applications: ApplicationsRepository,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly secrets: CatalogSecretGeneratorService,
    private readonly connectionUrl: BlockConnectionUrlService,
    private readonly generator?: ApplicationManifestGeneratorService,
  ) {}

  /** A pooler for a database being installed now: not routed until it proved ready. */
  newSpec(mode: PoolerMode, now = new Date()): PoolerSpec {
    return {
      enabled: true,
      mode,
      replicas: 1,
      image: pgbouncerImage(),
      authPasswordEnc: this.encryption.encrypt(
        this.secrets.generate(32, 'hex'),
      ),
      adminPasswordEnc: this.encryption.encrypt(
        this.secrets.generate(32, 'hex'),
      ),
      upstream: { mode: 'local' },
      routed: false,
      lastError: null,
      enabledAt: now.toISOString(),
    };
  }

  /**
   * Set the pooler's role up on the primary, wait for the pooler, then move
   * `FLUI_CONNECTION_URL` onto it. Never throws: a pooler that never carried
   * the URL and does not come up leaves it direct; one that already carries it
   * keeps it, since a slow refresh is no reason to move every consumer. Either
   * way the reason is on the pooler for the status to show.
   */
  async bringUp(
    appId: string,
    timeoutMs = POOLER_READY_TIMEOUT_MS,
  ): Promise<{ routed: boolean; reason: string | null }> {
    const app = await this.applications.findById(appId);
    if (!app?.pooler?.enabled) return { routed: false, reason: null };
    const wasRouted = !!app.pooler.routed;
    if (isStandby(app)) return { routed: wasRouted, reason: null };
    let spec: PoolerSpec = app.pooler;
    try {
      const kubeconfig = await this.kubeconfigOf(app);
      await this.ensureRole(app, kubeconfig);
      const names = poolerNames(app.slug);
      await this.kubernetes.waitForReady(
        kubeconfig,
        'Deployment',
        names.deployment,
        app.k8sNamespace,
        timeoutMs,
      );
      const upstream = await this.kubernetes.getResource(
        kubeconfig,
        'Service',
        names.upstream,
        app.k8sNamespace,
      );
      spec = {
        ...spec,
        routed: true,
        lastError: null,
        upstreamClusterIP:
          spec.upstreamClusterIP ?? upstream?.spec?.clusterIP ?? null,
      };
      app.pooler = spec;
      await this.connectionUrl.recompose(app);
      await this.applications.update(app.id, { pooler: spec });
      this.logger.log(
        `pooler of ${app.slug} is ready and carries the connection URL`,
      );
      return { routed: true, reason: null };
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      if (wasRouted) {
        const reason = `The pooler did not confirm it is ready after this deploy; apps still connect through it: ${cause}`;
        this.logger.warn(`pooler of ${app.slug}: ${reason}`);
        const kept: PoolerSpec = { ...spec, routed: true, lastError: reason };
        app.pooler = kept;
        await this.applications.update(app.id, { pooler: kept });
        return { routed: true, reason };
      }
      const reason = `The pooler did not become ready, so apps connect to the database directly: ${cause}`;
      this.logger.warn(`pooler of ${app.slug}: ${reason}`);
      const failed: PoolerSpec = { ...spec, routed: false, lastError: reason };
      app.pooler = failed;
      await this.connectionUrl.recompose(app).catch(() => undefined);
      await this.applications.update(app.id, { pooler: failed });
      return { routed: false, reason };
    }
  }

  /**
   * Apply the pooler's objects now, outside a deploy of the database, and wait
   * for the pooler to roll: how a pooler whose passwords changed picks them up.
   */
  async applyObjects(
    appId: string,
    timeoutMs = POOLER_READY_TIMEOUT_MS,
  ): Promise<void> {
    const app = await this.applications.findById(appId);
    if (!app?.pooler?.enabled || !this.generator) return;
    const kubeconfig = await this.kubeconfigOf(app);
    for (const m of poolerManifestsToApply(
      app,
      this.generator.generatePooler(app),
    )) {
      if (m.kind === ApplicationResourceKind.ENDPOINT_SLICE) {
        await this.kubernetes.applyManifest(kubeconfig, m.yaml);
      } else {
        await applyAppManifest(
          this.kubernetes,
          kubeconfig,
          m.yaml,
          app.k8sNamespace,
        );
      }
    }
    await this.kubernetes.waitForReady(
      kubeconfig,
      'Deployment',
      poolerNames(app.slug).deployment,
      app.k8sNamespace,
      timeoutMs,
    );
  }

  /**
   * The role and lookup functions PgBouncer authenticates with, on the
   * database's primary over the local socket. Only the password's SCRAM
   * verifier reaches psql, on stdin; nothing secret sits in argv.
   */
  async ensureRole(app: ApplicationEntity, kubeconfig: string): Promise<void> {
    if (!app.pooler) throw new Error(`${app.slug} has no pooler`);
    const identity = postgresIdentity(app.env, this.encryption);
    const user = assertPgbouncerName('database user', identity.user);
    const database = assertPgbouncerName('database name', identity.database);
    const script = ensurePoolerRoleScript(
      this.encryption.decrypt(app.pooler.authPasswordEnc),
    );
    await this.kubernetes.execStream(
      kubeconfig,
      app.k8sNamespace,
      `flui-app-id=${app.id}`,
      [
        'sh',
        '-c',
        `gosu postgres psql -U '${user}' -d '${database}' -v ON_ERROR_STOP=1 -tA -f -`,
      ],
      { stdin: Readable.from([script]) },
      app.slug,
    );
  }

  async status(appId: string): Promise<DbPoolerStatusDto> {
    const app = await this.applications.findById(appId);
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const direct = `${BlockConnectionUrlService.hostOf(app)}:${app.port ?? 5432}`;
    const spec = app.pooler;
    if (!spec?.enabled) {
      return {
        enabled: false,
        mode: null,
        replicas: 0,
        image: null,
        upstream: null,
        routed: false,
        reason: null,
        addresses: { pooled: null, direct },
        pods: [],
      };
    }
    const pods = await this.kubeconfigOf(app)
      .then((kubeconfig) =>
        this.kubernetes.listPodsByLabel(
          kubeconfig,
          app.k8sNamespace,
          `${POOLER_OF_LABEL}=${app.id}`,
        ),
      )
      .catch(() => []);
    return {
      enabled: true,
      mode: spec.mode,
      replicas: spec.suspended ? 0 : spec.replicas,
      image: spec.image,
      upstream: spec.upstream.mode,
      routed: !!spec.routed,
      reason: spec.lastError ?? null,
      addresses: {
        pooled: `${poolerHostOf(app)}:${POOLER_SERVICE_PORT}`,
        direct,
      },
      pods: pods.map((p) => ({
        name: p.metadata?.name ?? '',
        ready: !!p.status?.conditions?.some(
          (c) => c.type === 'Ready' && c.status === 'True',
        ),
      })),
    };
  }

  private async kubeconfigOf(app: ApplicationEntity): Promise<string> {
    const cluster = await this.clusters.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new Error(`cluster ${app.clusterId} has no kubeconfig`);
    }
    return this.encryption.decrypt(cluster.kubeconfigEncrypted);
  }
}

/** A migration's destination while it is still a standby: its role comes from the source. */
function isStandby(app: ApplicationEntity): boolean {
  return !!app.env?.some((e) => e.name === 'FLUI_PG_STANDBY' && !!e.value);
}
