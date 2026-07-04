import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { RestoreJobRepository } from '../repositories/restore-job.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import {
  PgBackrestService,
  PgBackupInfo,
} from '../services/pgbackrest.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { RestoreJobStatus } from '../enums/restore-job.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';
import { RunRestoreJobData } from './run-restore-job.processor';

const POSTGRESQL_SLUG = 'postgresql';
const INSTALL_POLL_INTERVAL_MS = 5_000;
const INSTALL_POLL_TIMEOUT_MS = 15 * 60 * 1000;
// WAL replay keeps running well past the pod turning Ready on big restores.
const RECONCILE_POLL_INTERVAL_MS = 5_000;
const RECONCILE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * PG_PITR restore: recover a database-class backup into a BRAND-NEW catalog
 * install (never in-place). The new postgresql install boots in restore-bootstrap
 * mode (image entrypoint) via injected FLUI_PG_* env, pulls from the source's
 * pgBackRest repo, recovers to the target time, promotes, and reconciles its
 * superuser password to this install's own secret.
 */
@Processor(BACKUP_QUEUE)
export class RunDbRestoreProcessor {
  private readonly logger = new Logger(RunDbRestoreProcessor.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(CatalogInstallEntity)
    private readonly installRepo: Repository<CatalogInstallEntity>,
    private readonly restoreRepo: RestoreJobRepository,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly destRepo: BackupDestinationRepository,
    private readonly pgbackrest: PgBackrestService,
    private readonly installer: CatalogInstallerService,
    private readonly k8s: KubernetesService,
  ) {}

  @Process(BACKUP_JOB_TYPES.RUN_DB_RESTORE)
  async handle(job: Job<RunRestoreJobData>): Promise<void> {
    const { restoreJobId, operationId } = job.data;
    this.logger.log(`[run-db-restore] Starting restoreJob=${restoreJobId}`);

    const setStep = async (step: OperationStep, progress: number) => {
      await this.opRepo.update(operationId, {
        currentStep: step,
        progress,
        status: OperationStatus.IN_PROGRESS,
        startedAt: progress <= 10 ? new Date() : undefined,
      });
    };

    try {
      const restore = await this.restoreRepo.findById(restoreJobId);
      if (!restore) throw new Error(`RestoreJob ${restoreJobId} not found`);
      const artifact = await this.artifactRepo.findArtifact(restore.artifactId);
      if (!artifact) throw new Error('Artifact not found');
      if (artifact.engineClass !== BackupEngineClass.DATABASE) {
        throw new Error('Artifact is not a database-class backup');
      }
      const sourceAppId = artifact.manifestSummary?.applicationId as
        | string
        | undefined;
      if (!sourceAppId) {
        throw new Error('Artifact has no source applicationId');
      }
      // The source app may be gone entirely (uninstalled, or its whole cluster
      // lost) — that is the disaster-recovery case this restore exists for.
      // The S3 repo is the source of truth; the app row only improves checks.
      const sourceApp = await this.appRepo.findOne({
        where: { id: sourceAppId },
      });
      const dest = await this.destRepo.findById(restore.sourceDestinationId);
      if (!dest) throw new Error('Source destination missing');
      const newInstall = restore.targetSelector?.newInstall;
      if (!newInstall?.name || !newInstall?.clusterId) {
        throw new Error(
          'targetSelector.newInstall { name, clusterId } required',
        );
      }

      await this.restoreRepo.update(restoreJobId, {
        status: RestoreJobStatus.RESTORING,
        startedAt: new Date(),
      });
      await setStep(OperationStep.RESTORE_SELECT_SOURCE, 10);

      const summary: Record<string, any> = artifact.manifestSummary ?? {};
      const effectiveTarget: Date | null = restore.recoveryTargetTime ?? null;
      const restoreSet = effectiveTarget
        ? null
        : await this.deriveRestoreSet(sourceAppId, artifact);

      await this.validateAgainstLiveRepo(sourceAppId, effectiveTarget);

      const sourceUser =
        (sourceApp && this.envValue(sourceApp, 'POSTGRES_USER')) ??
        (summary.pgUser as string | undefined) ??
        sourceAppId;
      const sourceDb =
        (sourceApp && this.envValue(sourceApp, 'POSTGRES_DB')) ??
        (summary.pgDb as string | undefined) ??
        sourceUser;
      const envOverrides: Record<string, string> = {
        ...this.pgbackrest.buildRestoreEnv(
          sourceAppId,
          dest,
          effectiveTarget,
          restoreSet,
        ),
        // Boot as the source's role/db (they exist in the restored data); the
        // password is reconciled to this install's own secret after recovery.
        POSTGRES_USER: sourceUser,
        POSTGRES_DB: sourceDb,
      };

      await setStep(OperationStep.RESTORE_CREATE_VELERO_CR, 30);
      const { install } = await this.installer.install(
        POSTGRESQL_SLUG,
        {
          clusterId: newInstall.clusterId,
          displayName: newInstall.name,
          envOverrides,
        },
        restore.userId,
      );
      await this.restoreRepo.update(restoreJobId, {
        previewResult: { createdInstallId: install.id },
      });

      await setStep(OperationStep.RESTORE_WATCH_PROGRESS, 60);
      const finalInstall = await this.waitForInstall(install.id);
      if (finalInstall.status !== CatalogInstallStatus.RUNNING) {
        throw new Error(
          `Restore install ${install.id} ended in status ${finalInstall.status}`,
        );
      }
      const newAppId = finalInstall.applicationIds?.[0];
      if (!newAppId) {
        throw new Error(
          `Restore install ${install.id} is RUNNING but has no application id`,
        );
      }

      // The restored roles carry the SOURCE's password. Reconcile the app's own
      // superuser to THIS install's generated secret from here, not the pod
      // entrypoint: it survives long WAL replays and container restarts, and a
      // failure fails the restore job instead of vanishing in a pod log.
      await setStep(OperationStep.RESTORE_POSTPROCESS, 85);
      await this.reconcilePassword(newAppId);

      // The FLUI_PG_* overrides carry live S3 credentials for the SOURCE's
      // backup repo and are only needed on first boot — drop them from the
      // stored rows so they don't outlive their purpose. (The in-cluster Secret
      // still holds them until the next redeploy regenerates the manifests.)
      await this.stripRestoreEnv(
        finalInstall.id,
        finalInstall.applicationIds ?? [],
      );

      await setStep(OperationStep.RESTORE_POSTPROCESS, 95);
      await this.restoreRepo.update(restoreJobId, {
        status: RestoreJobStatus.COMPLETED,
        finishedAt: new Date(),
        previewResult: {
          createdInstallId: finalInstall.id,
          createdApplicationIds: finalInstall.applicationIds,
        },
      });
      await this.opRepo.update(operationId, {
        status: OperationStatus.COMPLETED,
        completedAt: new Date(),
        progress: 100,
      });
      this.logger.log(
        `[run-db-restore] Completed restoreJob=${restoreJobId} → install ${finalInstall.id}`,
      );
    } catch (err: any) {
      this.logger.error(`[run-db-restore] Failed: ${err?.message}`);
      await this.restoreRepo.update(restoreJobId, {
        status: RestoreJobStatus.FAILED,
        errorMessage: err?.message ?? String(err),
        finishedAt: new Date(),
      });
      await this.opRepo.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: err?.message ?? String(err),
        completedAt: new Date(),
      });
      throw err;
    }
  }

  private envValue(app: ApplicationEntity, name: string): string | undefined {
    return app.env?.find((e) => e.name === name)?.value;
  }

  /**
   * Restoring an OLD artifact must mean that artifact's state: without a
   * target, recovery replays all WAL to the latest point regardless of which
   * artifact was picked — only the newest artifact means "latest". Pin the
   * backup set restored to its own consistency point (--type=immediate); a
   * derived TIME target equal to the backup's stop is rejected by pgBackRest,
   * which wants stop strictly < target.
   */
  private async deriveRestoreSet(
    sourceAppId: string,
    artifact: { id: string; engineRef?: string | null },
  ): Promise<string | null> {
    if (!artifact.engineRef) return null;
    const latest =
      await this.artifactRepo.findLatestDbArtifactForApp(sourceAppId);
    if (!latest || latest.id === artifact.id) return null;
    this.logger.log(
      `[run-db-restore] artifact ${artifact.id} is not the newest — restoring backup set ${artifact.engineRef} to its consistency point`,
    );
    return artifact.engineRef;
  }

  /**
   * Re-validate the repo at run time when the source pod is reachable —
   * auto-expire may have pruned the window the artifact row points at. When it
   * is not (the DR case), skip: pgBackRest itself fails cleanly on a bad repo.
   */
  private async validateAgainstLiveRepo(
    sourceAppId: string,
    effectiveTarget: Date | null,
  ): Promise<void> {
    let info: PgBackupInfo;
    try {
      info = await this.pgbackrest.info(sourceAppId);
    } catch (err: any) {
      this.logger.warn(
        `[run-db-restore] source repo not verifiable via live pod (${err?.message}) — proceeding against S3 directly`,
      );
      return;
    }
    if (info.backupCount === 0) {
      throw new Error('Source pgBackRest repo has no backups');
    }
    if (effectiveTarget && info.oldestRecoverable) {
      const target = effectiveTarget.getTime();
      const oldest = Date.parse(info.oldestRecoverable);
      if (target < oldest) {
        throw new Error(
          `Recovery target ${effectiveTarget.toISOString()} precedes the oldest recoverable point ${info.oldestRecoverable}`,
        );
      }
    }
  }

  /**
   * Wait out recovery on the restored install, then set the app's superuser
   * password to this install's own generated secret so the credentials Flui
   * shows for the clone actually work. Role and password come from the POD'S
   * OWN env (fed by the app Secret) — the control plane never materializes the
   * secret, and the encrypted-at-rest app.env copy is never touched.
   */
  private async reconcilePassword(newAppId: string): Promise<void> {
    const target = await this.pgbackrest.resolveTarget(newAppId);
    const exec = (cmd: string) =>
      this.k8s.execInPod(
        target.kubeconfig,
        target.namespace,
        target.labelSelector,
        target.container,
        ['sh', '-c', cmd],
      );

    const deadline = Date.now() + RECONCILE_TIMEOUT_MS;
    for (;;) {
      const out = await exec(
        `gosu postgres psql -U "$POSTGRES_USER" -d postgres -tAc 'SELECT NOT pg_is_in_recovery()' 2>/dev/null || true`,
      ).catch(() => '');
      if (out.trim() === 't') break;
      if (Date.now() > deadline) {
        throw new Error(
          'Restored postgres did not finish recovery in time — password not reconciled',
        );
      }
      await new Promise((r) => setTimeout(r, RECONCILE_POLL_INTERVAL_MS));
    }

    // psql interpolates :'pw' (safely quoted) only from stdin/-f, not from -c.
    await exec(
      String.raw`printf '%s\n' "ALTER ROLE \"$POSTGRES_USER\" WITH PASSWORD :'pw';" | gosu postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -v pw="$POSTGRES_PASSWORD"`,
    );
    this.logger.log(
      `[run-db-restore] reconciled superuser password for app=${newAppId}`,
    );
  }

  /** Drop the one-shot FLUI_PG_* restore env from the stored install/app rows. */
  private async stripRestoreEnv(
    installId: string,
    appIds: string[],
  ): Promise<void> {
    const install = await this.installRepo.findOne({
      where: { id: installId },
    });
    if (install?.envOverrides) {
      install.envOverrides = Object.fromEntries(
        Object.entries(install.envOverrides).filter(
          ([k]) => !k.startsWith('FLUI_PG_'),
        ),
      );
      await this.installRepo.save(install);
    }
    for (const appId of appIds) {
      const app = await this.appRepo.findOne({ where: { id: appId } });
      if (app?.env?.some((e) => e.name.startsWith('FLUI_PG_'))) {
        app.env = app.env.filter((e) => !e.name.startsWith('FLUI_PG_'));
        await this.appRepo.save(app);
      }
    }
  }

  private async waitForInstall(
    installId: string,
  ): Promise<CatalogInstallEntity> {
    const deadline = Date.now() + INSTALL_POLL_TIMEOUT_MS;
    for (;;) {
      const install = await this.installRepo.findOne({
        where: { id: installId },
      });
      if (!install) throw new Error(`Install ${installId} vanished`);
      if (
        install.status === CatalogInstallStatus.RUNNING ||
        install.status === CatalogInstallStatus.FAILED
      ) {
        return install;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Restore install ${installId} did not reach a terminal state in time (last=${install.status})`,
        );
      }
      await new Promise((r) => setTimeout(r, INSTALL_POLL_INTERVAL_MS));
    }
  }
}
