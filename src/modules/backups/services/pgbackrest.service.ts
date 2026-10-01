import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { RestoreStrategy } from '../enums/restore-job.enum';
import {
  ArtifactEngineFacts,
  RestorePointMark,
  ContinuousBackupEngine,
  EngineEnableOptions,
} from './continuous-backup-engine.interface';
import {
  latestPgBackup,
  parsePgManifestCompression,
} from './db-compression.util';
import { BackupDestinationsService } from './backup-destinations.service';
import { PgLegacyRepoRetirer } from './pg-legacy-repo.retirer';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { parseRestorePoint } from '../utils/restore-point.util';
import {
  REPO_PATH_MARKER,
  assertLiveRepository,
  encryptedRepoPrefix,
  parseRepoCipher,
  repositoryOf,
} from './pgbackrest-repo.util';
import {
  DATABASE_NOT_RUNNING,
  NO_PGBACKREST,
  NOT_IN_RECOVERY_SCRIPT,
  PGBACKREST_VERSION_COMMAND,
  PGBACKREST_PRESENT_SCRIPT,
  PGBACKREST_STANZA,
  PgBackrestTarget,
  PgBackupInfo,
  RECOVERY_ENDED_BEFORE_TARGET,
  RESET_SUPERUSER_PASSWORD_SCRIPT,
  RESTORE_RECONCILE_POLL_INTERVAL_MS,
  RESTORE_RECONCILE_TIMEOUT_MS,
  serverVersionCommand,
  archiveTimeoutSeconds,
  baseBackupScript,
  buildPgbackrestConf,
  disableScript,
  enableScript,
  infoJsonCommand,
  infoScript,
  manifestCompressionCommand,
  markRestorePointScript,
  parsePgbackrestInfo,
  pgRestoreEnv,
  pgbackrestTargetFor,
  restoreFailureFrom,
  withArchivedEdge,
} from './pgbackrest-config.util';

/**
 * Drives pgBackRest inside a managed Postgres pod over `kubectl exec`. Config +
 * WAL/base data live on the PVC (survives redeploys); credentials only ride the
 * one-time enable command. The Postgres image ships pgBackRest and is born with
 * archive_mode=on + a no-op archive_command, so enabling continuous backup is a
 * config write + ALTER SYSTEM reload — no restart.
 */
@Injectable()
export class PgBackrestService implements ContinuousBackupEngine {
  readonly engine = 'postgres';
  readonly catalogSlug = 'postgresql';
  readonly restoreEnvPrefix = 'FLUI_PG_';
  readonly restoreStrategy = RestoreStrategy.PG_PITR;
  readonly selfPrunesRepository = true;
  readonly replaysToEndWithoutTarget = true;

  private readonly logger = new Logger(PgBackrestService.name);

  constructor(
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly destinations: BackupDestinationsService,
    private readonly retirer: PgLegacyRepoRetirer,
  ) {}

  async requireTooling(appId: string): Promise<void> {
    await this.requirePgBackrest(await this.resolveTarget(appId));
  }

  /**
   * What a restore needs when the source application no longer exists.
   *
   * A database restore installs the catalog slug at whatever tag the seed
   * carries at that moment, and a data directory does not open under a
   * different major.
   * Recording the version does not make the restore choose the right image on
   * its own — it makes the mismatch something Flui can see and refuse on,
   * rather than something discovered halfway through a recovery.
   */
  async describeForArtifact(appId: string): Promise<ArtifactEngineFacts> {
    const target = await this.resolveTarget(appId);
    const read = (script: string): Promise<string | undefined> =>
      this.exec(target, script).then(
        (out) => out.trim().split('\n').pop(),
        () => undefined,
      );
    return {
      engine: this.engine,
      engineVersion: await read(serverVersionCommand(target)),
      tool: 'pgbackrest',
      toolVersion: await read(PGBACKREST_VERSION_COMMAND),
      catalogSlug: this.catalogSlug,
      identities: { user: target.pgUser, database: target.pgDb },
      ...(await this.observedRepository(target, appId)),
    };
  }

  /**
   * Cipher and compression read back from the repository rather than taken
   * from the configuration Flui wrote, so an artifact never claims an
   * encryption or a compression it does not have.
   */
  private async observedRepository(
    target: PgBackrestTarget,
    appId: string,
  ): Promise<Pick<ArtifactEngineFacts, 'repository' | 'compression'>> {
    const info = await this.exec(target, infoJsonCommand(target)).catch(
      () => '',
    );
    const latest = latestPgBackup(info, PGBACKREST_STANZA);
    const compression = latest
      ? await this.exec(
          target,
          manifestCompressionCommand(target, latest.label),
        )
          .then((m) => parsePgManifestCompression(m, latest.blockIncremental))
          .catch(() => null)
      : null;
    return {
      repository: {
        objectKeyPrefix: this.artifactObjectPrefix(appId),
        cipher: parseRepoCipher(info, PGBACKREST_STANZA) ?? 'unknown',
      },
      ...(compression ? { compression } : {}),
    };
  }

  artifactObjectPrefix(appId: string): string {
    return encryptedRepoPrefix(appId);
  }

  /**
   * Once this application has an encrypted full backup, its plaintext
   * repository is deleted from the bucket and its artifacts are marked gone.
   */
  async retirePlaintext(
    appId: string,
    artifact: BackupArtifactEntity,
  ): Promise<void> {
    await this.retirer.retire(appId, artifact);
  }

  identityEnv(identities: {
    user: string;
    database: string;
  }): Record<string, string> {
    return { POSTGRES_USER: identities.user, POSTGRES_DB: identities.database };
  }

  /**
   * Wait out recovery on the restored install, then set the app's superuser
   * password to this install's own generated secret so the credentials Flui
   * shows for the clone actually work.
   *
   * Role and password come from the POD'S OWN env (fed by the app Secret) —
   * the control plane never materializes the secret, and the encrypted-at-rest
   * `app.env` copy is never touched. Run from here rather than the pod
   * entrypoint because it survives long WAL replays and container restarts,
   * and a failure fails the restore job instead of vanishing into a pod log.
   */
  async reconcileAfterRestore(newAppId: string): Promise<void> {
    const target = await this.resolveTarget(newAppId);
    const run = (cmd: string) =>
      this.k8s.execInPod(
        target.kubeconfig,
        target.namespace,
        target.labelSelector,
        target.container,
        ['sh', '-c', cmd],
      );

    await this.untilPrimary(
      run,
      'Restored postgres did not finish recovery in time — password not reconciled',
    );

    // psql interpolates :'pw' (safely quoted) only from stdin/-f, not from -c.
    await run(RESET_SUPERUSER_PASSWORD_SCRIPT);
    this.logger.log(
      `[pgbackrest] reconciled superuser password for app=${newAppId}`,
    );
  }

  /**
   * Retention counts FULL backups, so an endless incr chain would never expire
   * and would pin the WAL archive forever — force a new full on a cadence so
   * the repo can rotate.
   */
  async chooseBackupType(
    appId: string,
    fullEveryDays: number,
  ): Promise<'full' | 'incr'> {
    const info = await this.info(appId);
    if (info.backupCount === 0 || !info.lastFullAt) return 'full';
    const ageMs = Date.now() - new Date(info.lastFullAt).getTime();
    return ageMs >= fullEveryDays * 86_400_000 ? 'full' : 'incr';
  }

  async resolveTarget(appId: string): Promise<PgBackrestTarget> {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster)
      throw new NotFoundException(`Cluster ${app.clusterId} missing`);
    return pgbackrestTargetFor(
      app,
      this.encryption.decrypt(cluster.kubeconfigEncrypted),
    );
  }

  private async exec(
    target: PgBackrestTarget,
    script: string,
  ): Promise<string> {
    const b64 = Buffer.from(script, 'utf-8').toString('base64');
    return this.k8s.execInPod(
      target.kubeconfig,
      target.namespace,
      target.labelSelector,
      target.container,
      ['sh', '-c', `echo ${b64} | base64 -d | sh`],
    );
  }

  /**
   * Refuse a database whose image cannot ship WAL, before touching it.
   *
   * Continuous backup needs `pgbackrest` inside the Postgres container, which
   * only Flui's own image carries. Without this check the first sign of trouble
   * is `stanza-create` failing on a "not found" — after the config file has
   * already been written into the container, and reported as if the destination
   * or the credentials were at fault.
   */
  private async requirePgBackrest(target: PgBackrestTarget): Promise<void> {
    // An exec that could not run says nothing about the image. Reporting it as
    // a missing binary sent the user to fix a thing that was never wrong, so
    // the two outcomes are kept apart: no pod is its own answer.
    let found: string;
    try {
      found = await this.exec(target, PGBACKREST_PRESENT_SCRIPT);
    } catch (err: any) {
      if (/No running pod/i.test(err?.message ?? '')) {
        throw new BadRequestException(DATABASE_NOT_RUNNING);
      }
      throw err;
    }
    if (found.trim().endsWith('yes')) return;
    throw new BadRequestException(NO_PGBACKREST);
  }

  /**
   * Readiness is `pg_isready`, which answers while the server is still
   * replaying in hot standby. `stanza-create` needs a primary, and the script
   * runs under `set -e`, so re-arming a still-recovering database fails.
   */
  async awaitWritable(appId: string): Promise<void> {
    const target = await this.resolveTarget(appId);
    await this.untilPrimary(
      (cmd) => this.exec(target, cmd),
      `${appId} was still replaying WAL after ${Math.round(RESTORE_RECONCILE_TIMEOUT_MS / 60000)} minutes, so WAL shipping could not be re-armed`,
    );
  }

  private async untilPrimary(
    run: (cmd: string) => Promise<string>,
    timeoutMessage: string,
  ): Promise<void> {
    const deadline = Date.now() + RESTORE_RECONCILE_TIMEOUT_MS;
    for (;;) {
      const out = await run(NOT_IN_RECOVERY_SCRIPT).catch(() => '');
      if (out.trim() === 't') return;
      if (Date.now() > deadline) throw new Error(timeoutMessage);
      await new Promise((r) =>
        setTimeout(r, RESTORE_RECONCILE_POLL_INTERVAL_MS),
      );
    }
  }

  /**
   * Idempotent: write the pgBackRest config, create the stanza, and flip
   * archive_command to push WAL — all without a restart.
   */
  async enable(
    appId: string,
    dest: BackupDestinationEntity,
    opts?: EngineEnableOptions,
  ): Promise<void> {
    const target = await this.resolveTarget(appId);
    await this.requirePgBackrest(target);
    const retentionFull = opts?.retentionFull ?? 2;
    const cipherPass = await this.destinations.passphraseFor(dest);
    const conf = buildPgbackrestConf({
      dest,
      target,
      repositoryPrefix: this.artifactObjectPrefix(appId),
      retentionFull,
      cipherPass,
      accessKey: this.encryption.decrypt(dest.accessKeyEncrypted),
      secretKey: this.encryption.decrypt(dest.secretKeyEncrypted),
    });
    await this.exec(
      target,
      enableScript(
        target,
        conf,
        archiveTimeoutSeconds(opts?.archiveTimeoutSeconds),
      ),
    );
    this.logger.log(`[pgbackrest] enabled continuous backup for app=${appId}`);
  }

  /**
   * Stop WAL shipping: back to the no-op archive_command the image is born
   * with. Without this, deleting a policy (or its destination/credentials)
   * leaves archive-push failing forever and Postgres retaining WAL until the
   * volume fills — an outage of the SOURCE database.
   */
  async disable(appId: string): Promise<void> {
    const target = await this.resolveTarget(appId);
    await this.exec(target, disableScript(target));
    this.logger.log(`[pgbackrest] disabled continuous backup for app=${appId}`);
  }

  /**
   * Postgres refuses a recovery target it never meets — a moment after the
   * last commit in the archive — and says so in its log before exiting.
   */
  async endedBeforeTarget(restoredAppId: string): Promise<boolean> {
    const ended = await this.firstFromPodLogs(
      restoredAppId,
      [undefined],
      (l) => (RECOVERY_ENDED_BEFORE_TARGET.test(l) ? true : null),
    );
    return ended ?? false;
  }

  async restoreFailure(restoredAppId: string): Promise<string | null> {
    return this.firstFromPodLogs(
      restoredAppId,
      [false, true],
      restoreFailureFrom,
    );
  }

  private async firstFromPodLogs<T>(
    appId: string,
    previousRuns: Array<boolean | undefined>,
    read: (logs: string) => T | null,
  ): Promise<T | null> {
    const target = await this.resolveTarget(appId);
    const pods = await this.k8s
      .listPodsByLabel(
        target.kubeconfig,
        target.namespace,
        target.labelSelector,
      )
      .catch(() => [] as any[]);
    for (const pod of pods) {
      const name = pod?.metadata?.name;
      if (!name) continue;
      for (const previous of previousRuns) {
        const logs = await this.k8s
          .getPodLogs(
            target.kubeconfig,
            name,
            target.namespace,
            target.container,
            200,
            previous,
          )
          .catch(() => '');
        const found = read(logs);
        if (found !== null) return found;
      }
    }
    return null;
  }

  /** Run a base backup. `type` is full|incr|diff. Returns the new backup label. */
  async baseBackup(
    appId: string,
    type: 'full' | 'incr' | 'diff' = 'full',
  ): Promise<string> {
    const target = await this.resolveTarget(appId);
    await this.exec(target, baseBackupScript(target, type));
    const info = await this.info(appId);
    if (!info.latestLabel) {
      throw new Error(
        'pgBackRest backup reported success but no backup in info',
      );
    }
    this.logger.log(
      `[pgbackrest] base backup ${info.latestLabel} for app=${appId}`,
    );
    return info.latestLabel;
  }

  /**
   * A named restore point, then a WAL switch: the segment holding the point is
   * closed and handed to `archive_command` now, so the point is off the
   * cluster within seconds instead of at the next `archive_timeout`.
   */
  async markRestorePoint(
    appId: string,
    label: string,
  ): Promise<RestorePointMark> {
    const target = await this.resolveTarget(appId);
    const out = await this.exec(target, markRestorePointScript(target, label));
    return parseRestorePoint(out);
  }

  /**
   * The repository's bases from `pgbackrest info`, and the recent edge of the
   * window from the server's archiver: the moment its last WAL segment
   * reached the repository. Every change archived by then is recoverable,
   * not only what the last base covers.
   */
  async info(
    appId: string,
    artifactSummary?: Record<string, unknown>,
  ): Promise<PgBackupInfo> {
    const target = await this.resolveTarget(appId);
    const out = await this.exec(target, infoScript(target));
    if (artifactSummary) {
      assertLiveRepository(appId, artifactSummary, out);
    }
    return withArchivedEdge(
      parsePgbackrestInfo(out.split(REPO_PATH_MARKER)[0]),
      out,
    );
  }

  /**
   * FLUI_PG_* env for a new install that boots in restore-bootstrap mode against
   * the given app's pgBackRest repo. Values ride envOverrides into the install;
   * the S3 secret lands in the app Secret once resolved. Target picks PITR,
   * restoreSet pins a backup label restored to its own consistency point
   * (as-of-that-backup); neither = latest (end of WAL).
   */
  buildRestoreEnv(
    sourceAppId: string,
    dest: BackupDestinationEntity,
    recoveryTargetTime?: Date | null,
    restoreSet?: string | null,
    _generation?: string,
    artifactSummary?: Record<string, unknown>,
  ): Record<string, string> {
    const repository = repositoryOf(sourceAppId, artifactSummary);
    const accessKey = this.encryption.decrypt(dest.accessKeyEncrypted);
    const secretKey = this.encryption.decrypt(dest.secretKeyEncrypted);
    return pgRestoreEnv({
      dest,
      repository,
      accessKey,
      secretKey,
      // The key that wrote it, never a new one: passphraseFor would mint a
      // passphrase for a destination that lost its own, and nothing decrypts
      // with that.
      passphrase: repository.encrypted
        ? this.destinations.decryptPassphrase(dest)
        : null,
      recoveryTargetTime,
      restoreSet,
    });
  }
}
