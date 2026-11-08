import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { RestoreStrategy } from '../enums/restore-job.enum';
import { BackupDestinationsService } from './backup-destinations.service';
import { PgBackrestService } from './pgbackrest.service';
import {
  ArtifactEngineFacts,
  ContinuousBackupEngine,
  EngineEnableOptions,
  RestorePointMark,
} from './continuous-backup-engine.interface';
import {
  PGBACKREST_STANZA,
  PgBackupInfo,
  s3EndpointHost,
  withArchivedEdge,
} from './pgbackrest-config.util';
import { repoPathIn } from './pgbackrest-repo.util';
import { parseRestorePoint } from '../utils/restore-point.util';
import {
  databaseHaServes,
  DatabaseHaSpec,
} from '../../postgres-ha/postgres-ha.types';
import { CNPG_API_VERSION } from '../../postgres-ha/postgres-ha.constants';
import { PgbackrestPluginInstallerService } from '../../postgres-ha/services/pgbackrest-plugin-installer.service';
import {
  archiveThroughPluginPatch,
  PGBACKREST_PLUGIN_API_VERSION,
  PGBACKREST_SIDECAR,
  pgbackrestStanzaName,
  pluginBackupState,
  promotedReplicaPatch,
  renderPgbackrestSecret,
  renderPgbackrestStanza,
  renderPluginBackup,
  stopArchivingPatch,
} from '../../postgres-ha/utils/pgbackrest-plugin.core';
import {
  archivedSince,
  CLEAR_COPIED_ARCHIVE_SETTINGS,
  infoFromStanza,
  parseArchivedSince,
  SWITCH_SEGMENT,
  haArchivedEdgeScript,
  haRepositoryPrefix,
  haRestorePointScript,
  REPOSITORY_ANNOTATION,
} from './pgbackrest-ha.util';

const ARCHIVING_TIMEOUT_MS = 15 * 60_000;
const BACKUP_TIMEOUT_MS = 2 * 60 * 60_000;
const POLL_MS = 10_000;

/** A failed exec rejects with a Kubernetes status, not an Error: its message is what says why. */
export function describeFailure(err: unknown): string {
  if (err instanceof Error) return err.message;
  const status = err as { message?: string; body?: { message?: string } };
  return (
    status?.message ??
    status?.body?.message ??
    JSON.stringify(err)?.slice(0, 300) ??
    String(err)
  );
}

interface HaTarget {
  app: ApplicationEntity;
  ha: DatabaseHaSpec;
  kubeconfig: string;
  namespace: string;
  labelSelector: string;
}

/**
 * Continuous backup of a highly available Postgres, through the pgBackRest
 * plugin of CloudNativePG: its instances ship their log to an encrypted
 * pgBackRest repository of their own, one per move to high availability, and
 * base backups are taken on the primary.
 *
 * The repository has the layout, stanza and cipher of the single instance's,
 * so a restore is the single instance's restore: a new flui-postgres booted
 * from it, to any moment the repository covers.
 */
@Injectable()
export class PgBackrestHaService implements ContinuousBackupEngine {
  readonly engine = 'postgres-ha';
  readonly catalogSlug = 'postgresql';
  readonly restoreEnvPrefix = 'FLUI_PG_';
  readonly restoreStrategy = RestoreStrategy.PG_PITR;
  readonly selfPrunesRepository = true;
  readonly replaysToEndWithoutTarget = true;

  private readonly logger = new Logger(PgBackrestHaService.name);

  constructor(
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly destinations: BackupDestinationsService,
    private readonly single: PgBackrestService,
    private readonly plugin: PgbackrestPluginInstallerService,
  ) {}

  private async target(appId: string): Promise<HaTarget> {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    if (!databaseHaServes(app.databaseHa)) {
      throw new BadRequestException(
        'This database is not highly available, so its own instance ships its log.',
      );
    }
    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(`Cluster ${app.clusterId} missing`);
    }
    return {
      app,
      ha: app.databaseHa,
      kubeconfig: this.encryption.decrypt(cluster.kubeconfigEncrypted),
      namespace: app.k8sNamespace,
      labelSelector: `cnpg.io/cluster=${app.databaseHa.cluster}`,
    };
  }

  private sidecar(t: HaTarget, command: string): Promise<string> {
    return this.k8s.execInPod(
      t.kubeconfig,
      t.namespace,
      t.labelSelector,
      PGBACKREST_SIDECAR,
      ['sh', '-c', command],
    );
  }

  private postgres(t: HaTarget, script: string): Promise<string> {
    return this.k8s.execInPod(
      t.kubeconfig,
      t.namespace,
      t.labelSelector,
      'postgres',
      ['sh', '-c', script],
    );
  }

  async requireTooling(appId: string): Promise<void> {
    const t = await this.target(appId);
    const cluster = await this.k8s
      .readObject(
        t.kubeconfig,
        CNPG_API_VERSION,
        'Cluster',
        t.ha.cluster,
        t.namespace,
      )
      .catch(() => null);
    if (!cluster) {
      throw new BadRequestException(
        `The highly available cluster ${t.ha.cluster} of this database is not there.`,
      );
    }
  }

  /** A repository per move to high availability: the instance it was copied from may have shipped to the old one until the last moment. */
  mintGeneration(): string {
    return new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  }

  artifactObjectPrefix(appId: string, generation?: string): string {
    return haRepositoryPrefix(appId, generation);
  }

  async enable(
    appId: string,
    dest: BackupDestinationEntity,
    opts?: EngineEnableOptions,
  ): Promise<void> {
    const t = await this.target(appId);
    await this.plugin.ensureInstalled(t.kubeconfig);
    const prefix = this.artifactObjectPrefix(appId, opts?.generation);
    const secret = renderPgbackrestSecret({
      cluster: t.ha.cluster,
      namespace: t.namespace,
      accessKey: this.encryption.decrypt(dest.accessKeyEncrypted),
      secretKey: this.encryption.decrypt(dest.secretKeyEncrypted),
      cipherPass: await this.destinations.passphraseFor(dest),
    });
    const stanza = renderPgbackrestStanza({
      cluster: t.ha.cluster,
      namespace: t.namespace,
      stanza: PGBACKREST_STANZA,
      repository: {
        bucket: dest.bucket,
        endpoint: s3EndpointHost(dest.endpoint),
        region: dest.region,
        repoPath: repoPathIn(dest.pathPrefix, prefix),
        pathStyle: !!dest.forcePathStyle,
        retentionFull: opts?.retentionFull ?? 2,
      },
    }) as { metadata: { annotations?: Record<string, string> } };
    stanza.metadata.annotations = { [REPOSITORY_ANNOTATION]: prefix };
    await this.k8s.serverSideApply(
      t.kubeconfig,
      [secret, stanza].map((o) => k8s.dumpYaml(o)).join('---\n'),
    );
    await this.forgetPromotedSource(t);
    await this.clearCopiedArchiveSettings(t);
    await this.k8s.mergePatchObject(
      t.kubeconfig,
      archiveThroughPluginPatch({
        cluster: t.ha.cluster,
        namespace: t.namespace,
      }),
    );
    try {
      await this.untilArchiving(t);
    } catch (err) {
      // A plugin left on a cluster that does not ship stops CloudNativePG
      // from reconciling it, failover included.
      await this.k8s
        .mergePatchObject(
          t.kubeconfig,
          stopArchivingPatch({ cluster: t.ha.cluster, namespace: t.namespace }),
        )
        .catch(() => undefined);
      throw err;
    }
    this.logger.log(
      `[pgbackrest-ha] ${t.ha.cluster}: shipping its log to ${prefix}`,
    );
  }

  /**
   * Adding the plugin restarts the instances one at a time; shipping is
   * proven once the primary has the sidecar and pgBackRest's own check, which
   * switches a segment and waits for it in the repository, passes.
   */
  private async forgetPromotedSource(t: HaTarget): Promise<void> {
    const cluster = await this.k8s.readObject(
      t.kubeconfig,
      CNPG_API_VERSION,
      'Cluster',
      t.ha.cluster,
      t.namespace,
    );
    const replica = cluster?.spec?.replica;
    if (replica && replica.enabled !== true) {
      await this.k8s.mergePatchObject(
        t.kubeconfig,
        promotedReplicaPatch({ cluster: t.ha.cluster, namespace: t.namespace }),
      );
    }
  }

  private async untilArchiving(t: HaTarget): Promise<void> {
    const segment = (await this.postgres(t, SWITCH_SEGMENT))
      .trim()
      .split('\n')
      .pop()!;
    const deadline = Date.now() + ARCHIVING_TIMEOUT_MS;
    let last = '';
    while (Date.now() < deadline) {
      try {
        const state = parseArchivedSince(
          await this.postgres(t, archivedSince(segment)),
        );
        if (state.archived) return;
        last = state.failed
          ? `segment ${state.failed} failed to reach the repository`
          : `segment ${segment} has not reached the repository yet`;
      } catch (err) {
        last = describeFailure(err);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(
      `The highly available cluster did not start shipping its log to the backup: ${last}`,
    );
  }

  /** The archive settings the copy brought along leave every instance, primary and copies alike. */
  private async clearCopiedArchiveSettings(t: HaTarget): Promise<void> {
    const pods = await this.k8s.listPodsByLabel(
      t.kubeconfig,
      t.namespace,
      t.labelSelector,
    );
    for (const pod of pods) {
      const name = pod?.metadata?.name;
      if (!name) continue;
      await this.k8s.execInPod(
        t.kubeconfig,
        t.namespace,
        t.labelSelector,
        'postgres',
        ['sh', '-c', CLEAR_COPIED_ARCHIVE_SETTINGS],
        name,
      );
    }
  }

  async disable(appId: string): Promise<void> {
    const t = await this.target(appId);
    await this.k8s.mergePatchObject(
      t.kubeconfig,
      stopArchivingPatch({ cluster: t.ha.cluster, namespace: t.namespace }),
    );
    const name = pgbackrestStanzaName(t.ha.cluster);
    await this.k8s
      .deleteObject(
        t.kubeconfig,
        PGBACKREST_PLUGIN_API_VERSION,
        'Stanza',
        name,
        t.namespace,
      )
      .catch(() => undefined);
    await this.k8s
      .deleteObject(t.kubeconfig, 'v1', 'Secret', name, t.namespace)
      .catch(() => undefined);
    this.logger.log(`[pgbackrest-ha] ${t.ha.cluster}: stopped shipping`);
  }

  async baseBackup(
    appId: string,
    type: 'full' | 'incr' | 'diff' = 'full',
  ): Promise<string> {
    const t = await this.target(appId);
    const name = `${t.ha.cluster}-${this.mintGeneration()}`;
    await this.k8s.serverSideApply(
      t.kubeconfig,
      k8s.dumpYaml(
        renderPluginBackup({
          name,
          cluster: t.ha.cluster,
          namespace: t.namespace,
          type,
        }),
      ),
    );
    const deadline = Date.now() + BACKUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const backup = await this.k8s
        .readObject(t.kubeconfig, CNPG_API_VERSION, 'Backup', name, t.namespace)
        .catch(() => null);
      const state = pluginBackupState(backup ?? {});
      if (state.phase === 'completed') {
        this.logger.log(`[pgbackrest-ha] base backup ${state.label}`);
        return state.label;
      }
      if (state.phase === 'failed') throw new Error(state.error);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(`The base backup ${name} did not finish in time`);
  }

  async chooseBackupType(
    appId: string,
    fullEveryDays: number,
  ): Promise<'full' | 'incr'> {
    const info = await this.info(appId);
    if (info.backupCount === 0 || !info.lastFullAt) return 'full';
    const ageMs = Date.now() - new Date(info.lastFullAt).getTime();
    return ageMs >= fullEveryDays * 86_400_000 ? 'full' : 'incr';
  }

  async info(appId: string): Promise<PgBackupInfo> {
    const t = await this.target(appId);
    const stanza = await this.stanzaOf(t);
    const edge = await this.postgres(t, haArchivedEdgeScript()).catch(() => '');
    return withArchivedEdge(infoFromStanza(stanza?.status), edge);
  }

  private stanzaOf(t: HaTarget): Promise<any> {
    return this.k8s
      .readObject(
        t.kubeconfig,
        PGBACKREST_PLUGIN_API_VERSION,
        'Stanza',
        pgbackrestStanzaName(t.ha.cluster),
        t.namespace,
      )
      .catch(() => null);
  }

  async describeForArtifact(appId: string): Promise<ArtifactEngineFacts> {
    const t = await this.target(appId);
    const single = await this.single.resolveTarget(appId);
    const read = (run: Promise<string>) =>
      run.then(
        (out) => out.trim().split('\n').pop(),
        () => undefined,
      );
    const stanza = await this.stanzaOf(t);
    return {
      engine: this.engine,
      engineVersion: await read(
        this.postgres(t, `psql -U postgres -Atc 'SHOW server_version'`),
      ),
      tool: 'pgbackrest',
      toolVersion: await read(
        this.sidecar(t, `pgbackrest version | awk '{print $2}'`),
      ),
      catalogSlug: this.catalogSlug,
      identities: { user: single.pgUser, database: single.pgDb },
      repository: {
        objectKeyPrefix:
          stanza?.metadata?.annotations?.[REPOSITORY_ANNOTATION] ??
          this.artifactObjectPrefix(appId),
        cipher:
          stanza?.spec?.stanzaConfiguration?.s3Repositories?.[0]?.cipherConfig
            ?.type ?? 'unknown',
      },
    };
  }

  async markRestorePoint(
    appId: string,
    label: string,
  ): Promise<RestorePointMark> {
    const t = await this.target(appId);
    return parseRestorePoint(
      await this.postgres(t, haRestorePointScript(label)),
    );
  }

  buildRestoreEnv(
    sourceAppId: string,
    destination: BackupDestinationEntity,
    recoveryTargetTime?: Date,
    restoreSet?: string,
    generation?: string,
    artifactSummary?: Record<string, unknown>,
  ): Record<string, string> {
    return this.single.buildRestoreEnv(
      sourceAppId,
      destination,
      recoveryTargetTime,
      restoreSet,
      generation,
      artifactSummary,
    );
  }

  identityEnv(identities: {
    user: string;
    database: string;
  }): Record<string, string> {
    return this.single.identityEnv(identities);
  }

  endedBeforeTarget(restoredAppId: string): Promise<boolean> {
    return this.single.endedBeforeTarget(restoredAppId);
  }

  restoreFailure(restoredAppId: string): Promise<string | null> {
    return this.single.restoreFailure(restoredAppId);
  }

  reconcileAfterRestore(newAppId: string): Promise<void> {
    return this.single.reconcileAfterRestore(newAppId);
  }
}
