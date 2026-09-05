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
import { UserEntity } from '../../auth/entities/user.entity';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { CatalogAppDefinitionRepository } from '../../catalog/repositories/catalog-app-definition.repository';
import { RestoreJobRepository } from '../repositories/restore-job.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { ContinuousBackupEngineRegistry } from '../services/continuous-backup-engine.registry';
import { ContinuousBackupEngine } from '../services/continuous-backup-engine.interface';
import { RestoreJobStatus } from '../enums/restore-job.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';
import { RunRestoreJobData } from './run-restore-job.processor';

const INSTALL_POLL_INTERVAL_MS = 5_000;
const INSTALL_POLL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Point-in-time restore of a database-class backup into a BRAND-NEW catalog
 * install, never in-place.
 *
 * The engine is read from the artifact, not from the source application: the
 * case this exists for is the one where that application, and possibly its
 * whole cluster, is gone. Whichever engine it names installs its own catalog
 * slug, boots it in restore mode through env it builds itself, and puts the
 * new install's own credentials back once the data is down.
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
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly restoreRepo: RestoreJobRepository,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly destRepo: BackupDestinationRepository,
    private readonly engines: ContinuousBackupEngineRegistry,
    private readonly definitionRepo: CatalogAppDefinitionRepository,
    private readonly installer: CatalogInstallerService,
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
      const engine = this.engines.forEngine(artifact.engine);
      const effectiveTarget: Date | null = restore.recoveryTargetTime ?? null;
      // The base is named here, always, and never left to the recovery to
      // choose for itself. Two reasons, and both are about the same instant:
      // a recovery that picks its own base from the repository can pick one
      // the retention sweeper is about to delete — the in-flight guard
      // protects the artifact this job names, not whatever the container
      // decided — and a base taken after the moment asked for would replay
      // nothing and hand back later state under an earlier label.
      const restoreSet = artifact.engineRef ?? null;
      if (effectiveTarget && artifact.createdAt > effectiveTarget) {
        throw new Error(
          `Backup ${artifact.engineRef ?? artifact.id} was taken at ` +
            `${artifact.createdAt.toISOString()}, after the ` +
            `${effectiveTarget.toISOString()} asked for. Restoring it would ` +
            'return state from after that moment while reporting the moment. ' +
            'Choose a backup taken before it.',
        );
      }

      await this.validateAgainstLiveRepo(engine, sourceAppId, effectiveTarget);

      const identities = this.resolveIdentities(
        sourceApp,
        summary,
        sourceAppId,
      );
      const envOverrides: Record<string, string> = {
        ...engine.buildRestoreEnv(
          sourceAppId,
          dest,
          effectiveTarget ?? undefined,
          restoreSet ?? undefined,
          // From the artifact, not from the application's current policy: the
          // objects being restored were written into the generation that was
          // current when they were taken, and a database restored more than
          // once has more than one.
          summary.generation as string | undefined,
        ),
        // Boot as the source's role/db — they are the ones that exist in the
        // recovered data. The password is put right once the data is down.
        ...engine.identityEnv(identities),
      };

      await this.requireRestoreAwareCatalogApp(engine);

      await setStep(OperationStep.RESTORE_CREATE_VELERO_CR, 30);
      // installer.install() persists the email onto the install row, and the
      // owning namespace is derived from it downstream in CatalogInstallProcessor
      // — a queue processor has no request principal to read it off, so it has
      // to be looked up here or every restore fails placement.
      const triggeringUser = await this.userRepo.findOne({
        where: { id: restore.userId },
      });
      const { install } = await this.installer.install(
        engine.catalogSlug,
        {
          clusterId: newInstall.clusterId,
          displayName: newInstall.name,
          envOverrides,
        },
        restore.userId,
        triggeringUser?.email,
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

      // The recovered accounts are the SOURCE's, so the new install's own
      // generated password does not open it. Engines that can only fix this
      // after boot do it here; the ones that do it during the restore, before
      // the server ever accepts a connection, have nothing left to do.
      await setStep(OperationStep.RESTORE_POSTPROCESS, 85);
      if (engine.reconcileAfterRestore) {
        await engine.reconcileAfterRestore(newAppId);
      }

      // The restore overrides carry live S3 credentials for the SOURCE's
      // repository and are only needed on first boot — drop them from the
      // stored rows so they don't outlive their purpose. (The in-cluster Secret
      // still holds them until the next redeploy regenerates the manifests.)
      await this.stripRestoreEnv(
        engine.restoreEnvPrefix,
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
   * The role and database the restored instance has to boot as.
   *
   * From the artifact first, because the source application is exactly what a
   * disaster restore does not have. `pgUser`/`pgDb` are read after it for
   * artifacts written before engines existed, when those were the only names
   * this summary carried; the live application is consulted last and only to
   * cover rows older still, which recorded neither.
   */
  private resolveIdentities(
    sourceApp: ApplicationEntity | null,
    summary: Record<string, any>,
    sourceAppId: string,
  ): { user: string; database: string } {
    const recorded = summary.identities as
      | { user?: string; database?: string }
      | undefined;
    const user =
      recorded?.user ??
      (summary.pgUser as string | undefined) ??
      (sourceApp ? this.envValue(sourceApp, 'POSTGRES_USER') : undefined) ??
      (sourceApp ? this.envValue(sourceApp, 'MARIADB_USER') : undefined) ??
      sourceAppId;
    const database =
      recorded?.database ??
      (summary.pgDb as string | undefined) ??
      (sourceApp ? this.envValue(sourceApp, 'POSTGRES_DB') : undefined) ??
      (sourceApp ? this.envValue(sourceApp, 'MARIADB_DATABASE') : undefined) ??
      user;
    return { user, database };
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
    engine: ContinuousBackupEngine,
    sourceAppId: string,
    effectiveTarget: Date | null,
  ): Promise<void> {
    const engineName = engine.engine;
    let info: Awaited<ReturnType<ContinuousBackupEngine['info']>>;
    try {
      info = await engine.info(sourceAppId);
    } catch (err: any) {
      this.logger.warn(
        `[run-db-restore] source repo not verifiable via live pod (${err?.message}) — proceeding against S3 directly`,
      );
      return;
    }
    if (info.backupCount === 0) {
      throw new Error('The source repository holds no base backup');
    }
    // `oldestRecoverable` is a timestamp for one engine and a base label for
    // another, so it is only compared when it parses as a moment. It silently
    // did not before: `Date.parse` on a MariaDB label gives NaN, every
    // comparison against it is false, and a refusal that can never fire reads
    // exactly like one that never had to.
    if (effectiveTarget && info.oldestRecoverable) {
      const oldest = Date.parse(info.oldestRecoverable);
      if (Number.isNaN(oldest)) {
        this.logger.log(
          `[run-db-restore] the ${engineName} repository reports its window as ` +
            `"${info.oldestRecoverable}", which is not an instant — the target ` +
            'is checked against the chosen backup instead',
        );
      } else if (effectiveTarget.getTime() < oldest) {
        throw new Error(
          `Recovery target ${effectiveTarget.toISOString()} precedes the oldest recoverable point ${info.oldestRecoverable}`,
        );
      }
    }
  }

  /** Drop the one-shot restore env from the stored install/app rows. */
  private async stripRestoreEnv(
    prefix: string,
    installId: string,
    appIds: string[],
  ): Promise<void> {
    const install = await this.installRepo.findOne({
      where: { id: installId },
    });
    if (install?.envOverrides) {
      install.envOverrides = Object.fromEntries(
        Object.entries(install.envOverrides).filter(
          ([k]) => !k.startsWith(prefix),
        ),
      );
      await this.installRepo.save(install);
    }
    for (const appId of appIds) {
      const app = await this.appRepo.findOne({ where: { id: appId } });
      if (app?.env?.some((e) => e.name.startsWith(prefix))) {
        app.env = app.env.filter((e) => !e.name.startsWith(prefix));
        await this.appRepo.save(app);
      }
    }
  }

  /**
   * Refuse when the catalog app cannot receive the restore switch.
   *
   * `resolveEnv` walks the env the manifest DECLARES and reads an override
   * only for those names — an override for an undeclared name is dropped
   * without a word. A restore whose environment is dropped does not fail: the
   * image initialises an empty data directory, the pod turns Ready, and the
   * job reports success over a database that contains nothing. That is the one
   * outcome this whole area exists to stop producing, so it is checked before
   * anything is installed rather than discovered afterwards.
   */
  private async requireRestoreAwareCatalogApp(
    engine: ContinuousBackupEngine,
  ): Promise<void> {
    const switchName = `${engine.restoreEnvPrefix}RESTORE`;
    const definition = await this.definitionRepo.findPublishedBySlug(
      engine.catalogSlug,
    );
    if (!definition) {
      throw new Error(
        `Catalog app "${engine.catalogSlug}" is not published, so a ${engine.engine} backup cannot be restored into a new install`,
      );
    }
    const spec = definition.manifest?.spec as
      | { env?: Array<{ name: string }> }
      | undefined;
    if (!spec?.env?.some((e) => e.name === switchName)) {
      throw new Error(
        `The "${engine.catalogSlug}" catalog app does not declare ${switchName}, ` +
          'so the restore environment would be silently dropped and the new ' +
          'install would come up empty. Restoring this engine needs a catalog ' +
          'that boots it in restore mode.',
      );
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
