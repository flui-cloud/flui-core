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
import { DbRestorePlan, planDbRestore } from '../utils/db-restore-plan.util';
import { resolveRestoreIdentities } from '../utils/db-restore-identities.util';
import {
  assertArtifactStillStored,
  assertTargetFitsArtifact,
  assertRestoreAwareManifest,
  assertTargetWithinWindow,
  DbRestoreContext,
  describeDbRestorePlan,
  everythingArchivedPlan,
  parseNewestArchived,
  withoutPrefixedKeys,
} from '../utils/db-restore-checks.util';

const INSTALL_POLL_INTERVAL_MS = 5_000;
const INSTALL_POLL_TIMEOUT_MS = 15 * 60 * 1000;
type RepoInfo = Awaited<ReturnType<ContinuousBackupEngine['info']>>;

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
export interface RunRestoreJobData {
  restoreJobId: string;
  operationId: string;
}

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
    try {
      await this.run(restoreJobId, operationId);
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

  private async setStep(
    operationId: string,
    step: OperationStep,
    progress: number,
  ): Promise<void> {
    await this.opRepo.update(operationId, {
      currentStep: step,
      progress,
      status: OperationStatus.IN_PROGRESS,
      startedAt: progress <= 10 ? new Date() : undefined,
    });
  }

  private async run(restoreJobId: string, operationId: string): Promise<void> {
    const ctx = await this.loadContext(restoreJobId);
    await this.restoreRepo.update(restoreJobId, {
      status: RestoreJobStatus.RESTORING,
      startedAt: new Date(),
    });
    await this.setStep(operationId, OperationStep.RESTORE_SELECT_SOURCE, 10);

    assertArtifactStillStored(ctx.artifact, ctx.dest.id);
    const engine = this.engines.forEngine(ctx.artifact.engine);
    assertTargetFitsArtifact(
      ctx.artifact,
      ctx.requestedTarget,
      engine.pointInTime,
    );
    const plan = await this.initialPlan(ctx, engine);
    const envFor = this.restoreEnvBuilder(ctx, engine);
    const firstEnv = envFor(plan);
    if (!engine.loadIntoRestored) {
      assertRestoreAwareManifest(
        await this.definitionRepo.findPublishedBySlug(engine.catalogSlug),
        engine,
        Object.keys(firstEnv),
      );
    }

    await this.setStep(operationId, OperationStep.RESTORE_INSTALL_TARGET, 30);
    const finalInstall = await this.installRestored(
      ctx,
      engine,
      plan,
      envFor,
      firstEnv,
      operationId,
    );
    const newAppId = finalInstall.applicationIds?.[0];
    if (!newAppId) {
      throw new Error(
        `Restore install ${finalInstall.id} is RUNNING but has no application id`,
      );
    }

    await this.setStep(operationId, OperationStep.RESTORE_POSTPROCESS, 85);
    await this.finishRestoredData(ctx, engine, finalInstall, newAppId);

    // The restore overrides carry live S3 credentials for the SOURCE's
    // repository and are only needed on first boot — drop them from the
    // stored rows so they don't outlive their purpose. (The in-cluster Secret
    // still holds them until the next redeploy regenerates the manifests.)
    await this.stripRestoreEnv(
      engine.restoreEnvPrefix,
      finalInstall.id,
      finalInstall.applicationIds ?? [],
    );

    await this.setStep(operationId, OperationStep.RESTORE_POSTPROCESS, 95);
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
  }

  private async loadContext(restoreJobId: string): Promise<DbRestoreContext> {
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
      throw new Error('targetSelector.newInstall { name, clusterId } required');
    }
    return {
      restoreJobId,
      restore,
      artifact,
      sourceAppId,
      sourceApp,
      dest,
      newInstall,
      summary: artifact.manifestSummary ?? {},
      requestedTarget: restore.recoveryTargetTime ?? null,
    };
  }

  private async initialPlan(
    ctx: DbRestoreContext,
    engine: ContinuousBackupEngine,
  ): Promise<DbRestorePlan> {
    const info = await this.validateAgainstLiveRepo(
      engine,
      ctx.sourceAppId,
      ctx.requestedTarget,
      ctx.summary,
    );
    const newest = await this.artifactRepo.findLatestDbArtifactForApp(
      ctx.sourceAppId,
    );
    const plan = planDbRestore({
      requestedTarget: ctx.requestedTarget,
      artifactEngineRef: ctx.artifact.engineRef ?? null,
      artifactIsNewest: !newest || newest.id === ctx.artifact.id,
      newestArchived: parseNewestArchived(info?.newestRecoverable),
      noChangesArchived: !!info && !info.newestRecoverable,
      replaysToEndWithoutTarget: engine.replaysToEndWithoutTarget,
      now: new Date(),
    });
    this.logger.log(
      `[run-db-restore] restoreJob=${ctx.restoreJobId} ${describeDbRestorePlan(plan)}`,
    );
    return plan;
  }

  private restoreEnvBuilder(
    ctx: DbRestoreContext,
    engine: ContinuousBackupEngine,
  ): (p: DbRestorePlan) => Record<string, string> {
    const identities = resolveRestoreIdentities(
      ctx.sourceApp,
      ctx.summary,
      ctx.sourceAppId,
    );
    return (p) => ({
      ...engine.buildRestoreEnv(
        ctx.sourceAppId,
        ctx.dest,
        p.recoveryTargetTime,
        p.restoreSet,
        // From the artifact, not from the application's current policy: the
        // objects being restored were written into the generation that was
        // current when they were taken, and a database restored more than
        // once has more than one.
        ctx.summary.generation as string | undefined,
        ctx.summary,
      ),
      // Boot as the source's role/db — they are the ones that exist in the
      // recovered data. The password is put right once the data is down.
      ...engine.identityEnv(identities),
    });
  }

  private async installRestored(
    ctx: DbRestoreContext,
    engine: ContinuousBackupEngine,
    initial: DbRestorePlan,
    envFor: (p: DbRestorePlan) => Record<string, string>,
    firstEnv: Record<string, string>,
    operationId: string,
  ): Promise<CatalogInstallEntity> {
    const { restore, restoreJobId, newInstall } = ctx;
    // installer.install() persists the email onto the install row, and the
    // owning namespace is derived from it downstream in CatalogInstallProcessor
    // — a queue processor has no request principal to read it off, so it has
    // to be looked up here or every restore fails placement.
    const triggeringUser = await this.userRepo.findOne({
      where: { id: restore.userId },
    });
    const attempt = async (p: DbRestorePlan, env = envFor(p)) => {
      const { install } = await this.installer.install(
        engine.catalogSlug,
        {
          clusterId: newInstall.clusterId,
          displayName: newInstall.name,
          envOverrides: env,
        },
        restore.userId,
        triggeringUser?.email,
      );
      await this.restoreRepo.update(restoreJobId, {
        previewResult: { createdInstallId: install.id },
      });
      return { install, finalInstall: await this.waitForInstall(install.id) };
    };

    await this.setStep(operationId, OperationStep.RESTORE_WATCH_PROGRESS, 60);
    let plan = initial;
    let { install, finalInstall } = await attempt(plan, firstEnv);
    // Past the last archived commit, Postgres stops with an error instead of
    // at the end: it is the one reply that proves nothing archived came after
    // the moment, so "everything archived" is that moment's state.
    if (
      finalInstall.status !== CatalogInstallStatus.RUNNING &&
      plan.mode === 'point-in-time' &&
      (await this.endedBeforeTarget(engine, finalInstall))
    ) {
      this.logger.log(
        `[run-db-restore] restoreJob=${restoreJobId}: nothing archived after ${plan.recoveryTargetTime?.toISOString()} — restoring everything archived instead`,
      );
      await this.removeFailedInstall(install.id, restore.userId);
      plan = everythingArchivedPlan(
        ctx.artifact.engineRef ?? null,
        engine.replaysToEndWithoutTarget,
      );
      ({ install, finalInstall } = await attempt(plan));
    }
    if (finalInstall.status !== CatalogInstallStatus.RUNNING) {
      const reason = await this.restoreFailure(engine, finalInstall);
      const cause = reason ? `: ${reason}` : '.';
      throw new Error(
        `The restored database did not start${cause} ${await this.removeFailedInstall(install.id, restore.userId)}` +
          (!reason && plan.mode === 'point-in-time'
            ? ` If nothing was written after ${plan.recoveryTargetTime?.toISOString()}, restore without a time to recover everything that was archived.`
            : ''),
      );
    }
    return finalInstall;
  }

  /**
   * The recovered accounts are the SOURCE's, so the new install's own
   * generated password does not open it. Engines that can only fix this after
   * boot do it here; the ones that do it during the restore, before the server
   * ever accepts a connection, have nothing left to do.
   */
  private async finishRestoredData(
    ctx: DbRestoreContext,
    engine: ContinuousBackupEngine,
    finalInstall: CatalogInstallEntity,
    newAppId: string,
  ): Promise<void> {
    if (engine.reconcileAfterRestore) {
      await engine.reconcileAfterRestore(newAppId);
    }
    if (!engine.loadIntoRestored) return;
    if (!ctx.artifact.engineRef) {
      throw new Error('The backup does not name the dump it holds');
    }
    try {
      await engine.loadIntoRestored(newAppId, {
        sourceAppId: ctx.sourceAppId,
        engineRef: ctx.artifact.engineRef,
        destination: ctx.dest,
      });
    } catch (err: any) {
      throw new Error(
        `${err?.message ?? err}. ${await this.removeFailedInstall(finalInstall.id, ctx.restore.userId)}`,
      );
    }
  }

  private async endedBeforeTarget(
    engine: ContinuousBackupEngine,
    install: CatalogInstallEntity,
  ): Promise<boolean> {
    const appId = install.applicationIds?.[0];
    if (!appId || !engine.endedBeforeTarget) return false;
    return engine.endedBeforeTarget(appId).catch(() => false);
  }

  private async restoreFailure(
    engine: ContinuousBackupEngine,
    install: CatalogInstallEntity,
  ): Promise<string | null> {
    const appId = install.applicationIds?.[0];
    if (!appId || !engine.restoreFailure) return null;
    return engine.restoreFailure(appId).catch(() => null);
  }

  /**
   * A restore that failed leaves nothing worth keeping: an empty data volume
   * and a server restarting forever. Removing it is part of failing.
   */
  private async removeFailedInstall(
    installId: string,
    userId: string,
  ): Promise<string> {
    try {
      await this.installer.uninstall(installId, userId);
      return 'The new database it created is being removed.';
    } catch (err: any) {
      this.logger.warn(
        `[run-db-restore] could not remove failed install ${installId}: ${err?.message}`,
      );
      return `The new database it created (${installId}) could not be removed automatically; delete it.`;
    }
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
    artifactSummary: Record<string, unknown>,
  ): Promise<RepoInfo | null> {
    let info: RepoInfo;
    try {
      info = await engine.info(sourceAppId, artifactSummary);
    } catch (err: any) {
      this.logger.warn(
        `[run-db-restore] source repo not verifiable via live pod (${err?.message}) — proceeding against S3 directly`,
      );
      return null;
    }
    if (info.backupCount === 0) {
      throw new Error('The source repository holds no base backup');
    }
    if (
      effectiveTarget &&
      !assertTargetWithinWindow(effectiveTarget, info.oldestRecoverable)
    ) {
      this.logger.log(
        `[run-db-restore] the ${engine.engine} repository reports its window as ` +
          `"${info.oldestRecoverable}", which is not an instant — the target ` +
          'is checked against the chosen backup instead',
      );
    }
    return info;
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
      install.envOverrides = withoutPrefixedKeys(install.envOverrides, prefix);
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
