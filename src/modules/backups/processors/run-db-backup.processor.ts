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
import {
  BackupJobsService,
  RunBackupJobData,
} from '../services/backup-jobs.service';
import { BackupPoliciesService } from '../services/backup-policies.service';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { ContinuousBackupEngineRegistry } from '../services/continuous-backup-engine.registry';
import { BackupJobStatus } from '../enums/backup-job.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';

@Processor(BACKUP_QUEUE)
export class RunDbBackupProcessor {
  private readonly logger = new Logger(RunDbBackupProcessor.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    private readonly jobsService: BackupJobsService,
    private readonly policiesService: BackupPoliciesService,
    private readonly destRepo: BackupDestinationRepository,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly engines: ContinuousBackupEngineRegistry,
  ) {}

  @Process(BACKUP_JOB_TYPES.RUN_DB_BACKUP)
  async handle(job: Job<RunBackupJobData>): Promise<void> {
    const { backupJobId, operationId } = job.data;
    this.logger.log(`[run-db-backup] Starting backupJob=${backupJobId}`);

    const setStep = async (step: OperationStep, progress: number) => {
      await this.opRepo.update(operationId, {
        currentStep: step,
        progress,
        status: OperationStatus.IN_PROGRESS,
        startedAt: progress <= 10 ? new Date() : undefined,
      });
    };

    try {
      const backupJob = await this.jobsService.findById(backupJobId);
      if (!backupJob.policyId) {
        throw new Error('database backup job has no policy');
      }
      const policy = await this.policiesService.findById(backupJob.policyId);
      const appId = policy.scopeSelector?.applicationIds?.[0];
      if (!appId) {
        throw new Error(
          'database policy scopeSelector.applicationIds[0] is required',
        );
      }
      const primaryDest = this.policiesService.primaryDestinationOf(policy);
      const destEntity = await this.destRepo.findById(
        primaryDest.destinationId,
      );
      if (!destEntity) throw new Error('primary destination not found');

      await this.jobsService.update(backupJobId, {
        status: BackupJobStatus.RUNNING,
        startedAt: new Date(),
      });

      await setStep(OperationStep.BACKUP_RUN_RESOLVE_SCOPE, 10);

      // By the engine the policy recorded at creation, never re-derived from
      // the workload: this job can run when that workload is mid-redeploy, and
      // driving one database's tool against another's is the failure the
      // registry exists to make impossible.
      const engine = this.engines.forEngine(policy.engine);

      // Idempotent + self-healing: (re)write conf, ensure the stanza exists, flip
      // archive_command. No restart (see D1/D2). Cheap next to the base backup.
      // From the policy, never minted here: a new generation on every run
      // would scatter one database's history across a new prefix each night.
      const generation = policy.metadata?.generation as string | undefined;
      await engine.enable(appId, destEntity, {
        retentionFull: policy.retentionMaxCopies ?? 2,
        generation,
      });

      // Engines with a single kind of base backup do not answer this, and the
      // answer for them is `full` — a fact about the engine, not a fallback.
      const fullEveryDays = Number(policy.metadata?.fullEveryDays) || 7;
      const type = engine.chooseBackupType
        ? await engine.chooseBackupType(appId, fullEveryDays)
        : 'full';

      await setStep(OperationStep.BACKUP_RUN_RECORD_ARTIFACT, 40);
      const label = await engine.baseBackup(appId, type);
      const info = await engine.info(appId);

      // Read from the running server, not assumed from the seed: the restore
      // installs whatever tag the catalog carries at restore time, and a data
      // directory does not open under a different major. Recorded here so the
      // mismatch is visible before a recovery rather than during one.
      const facts = await engine.describeForArtifact(appId);
      const artifact = this.artifactRepo.createArtifact({
        backupJobId,
        clusterId: backupJob.clusterId,
        engineClass: BackupEngineClass.DATABASE,
        // On the column, not only inside `manifestSummary`: the ledger's whole
        // point is that "what protects this application" is one query, and a
        // database artifact that answers only from a jsonb blob is invisible
        // to it.
        applicationId: appId,
        engine: facts.engine,
        // Clamped, not trusted to fit. The base backup is already in object
        // storage by the time this row is written: a version banner one
        // character too long would fail the insert, mark the job failed, and
        // leave a real backup that nothing points at. MariaDB's banner is 41
        // characters against Postgres's 30, which is how that was found.
        engineVersion: facts.engineVersion?.slice(0, 64),
        engineRef: label,
        manifestSummary: {
          applicationId: appId,
          backupType: type,
          tool: facts.tool,
          toolVersion: facts.toolVersion,
          catalogSlug: facts.catalogSlug,
          // The role and database a restored instance has to boot as. They
          // ride the artifact because the moment they are needed is the one
          // where the source application, and possibly its cluster, is gone.
          identities: facts.identities,
          // Recorded on the artifact because a restore years from now has to
          // find the objects, and the policy that knew where they went may be
          // gone by then.
          ...(generation ? { generation } : {}),
          // The same pair under the names the restore read before engines
          // existed, so an artifact taken today still restores on a Flui that
          // has not been upgraded. Removable once no such reader is left.
          ...(facts.engine === 'postgres'
            ? { pgUser: facts.identities.user, pgDb: facts.identities.database }
            : {}),
          oldestRecoverable: info.oldestRecoverable,
          newestRecoverable: info.newestRecoverable,
        },
        // Deliberately no `expiresAt`. Retention for this class is counted in
        // base backups, not days — that is what `repo1-retention-full` means
        // to pgBackRest and what a chain means for any engine: dropping a base
        // on a calendar says nothing about how far back recovery reaches,
        // because the logs between the bases are what fill the gaps. Two
        // clocks on one policy is how the CLI came to show a number nothing
        // honoured while the sweeper acted on one nobody set.
      });
      const saved = await this.artifactRepo.saveArtifact(artifact);

      const loc: Partial<BackupArtifactLocationEntity> = {
        artifactId: saved.id,
        destinationId: destEntity.id,
        role: DestinationRole.PRIMARY,
        state: ArtifactLocationState.AVAILABLE,
        // Relative to pathPrefix — the engine's own repository path already
        // includes it, and getUsage()/listObjects() re-prepend it via
        // joinPrefix, so it must not be here.
        objectKeyPrefix: engine.artifactObjectPrefix(appId, generation),
      };
      await this.artifactRepo.saveLocation(loc as BackupArtifactLocationEntity);

      await this.jobsService.update(backupJobId, {
        status: BackupJobStatus.COMPLETED,
        finishedAt: new Date(),
        metadata: { engineRef: label, backupType: type },
      });

      await setStep(OperationStep.BACKUP_RUN_FINALIZE, 100);
      await this.opRepo.update(operationId, {
        status: OperationStatus.COMPLETED,
        completedAt: new Date(),
        progress: 100,
      });
      this.logger.log(
        `[run-db-backup] Completed backupJob=${backupJobId} label=${label} type=${type}`,
      );
    } catch (err: any) {
      this.logger.error(`[run-db-backup] Failed: ${err?.message}`);
      await this.jobsService.update(backupJobId, {
        status: BackupJobStatus.FAILED,
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
}
