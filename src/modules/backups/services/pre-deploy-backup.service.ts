import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { BackupJobRepository } from '../repositories/backup-job.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import {
  BackupJobStatus,
  BackupJobTriggerType,
} from '../enums/backup-job.enum';
import { BackupJobsService } from './backup-jobs.service';
import { ContinuousBackupEngineRegistry } from './continuous-backup-engine.registry';
import { RESTORE_POINT_KIND } from '../utils/restore-point.util';

export interface PreDeployBackupRequest {
  applicationId: string;
  deployId: string;
}

export interface PreDeployBackupResult {
  applicationId: string;
  /** The moment a continuous database can be restored to, recorded before the deploy. */
  restorePoint?: {
    artifactId: string;
    at: string;
    position?: string;
    engine: string;
  };
  /** A dump started for a database that restores only what a dump holds. */
  dumpJobId?: string;
  /** The volume copy started for the other volumes; the deploy does not wait for it. */
  volumeJobId?: string;
}

/** Whether a backup is taken before each deploy of an application, and what it takes. */
export interface BeforeDeployOption {
  applicationId: string;
  enabled: boolean;
  /** The deploy fails when the backup before it cannot be taken. */
  required: boolean;
  takes: { restorePoint: boolean; dump: boolean; volumes: boolean };
  warning?: string;
}

export class NothingToBackUpBeforeDeploy extends Error {
  constructor() {
    super(
      'No backup policy protects this application, so there is nothing to take before the deploy.',
    );
  }
}

/**
 * The backup taken before a deploy, shaped so the deploy waits for as little as
 * possible:
 *
 * - a continuous database records a restore point (a named moment and the log
 *   position, with the log pushed off the cluster at once) — seconds, and the
 *   deploy waits for it, because it is the point to go back to;
 * - a database kept by dumps starts a dump, and every other volume starts a
 *   copy under the application's own policy — both run on their own, with
 *   their own rows, and the deploy goes ahead without them.
 */
@Injectable()
export class PreDeployBackupService {
  private readonly logger = new Logger(PreDeployBackupService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    private readonly policies: BackupPolicyRepository,
    private readonly jobRows: BackupJobRepository,
    private readonly artifacts: BackupArtifactRepository,
    private readonly jobs: BackupJobsService,
    private readonly engines: ContinuousBackupEngineRegistry,
  ) {}

  async run(req: PreDeployBackupRequest): Promise<PreDeployBackupResult> {
    const app = await this.apps.findOne({ where: { id: req.applicationId } });
    if (!app) {
      throw new NotFoundException(`Application ${req.applicationId} not found`);
    }
    const { database, volumes } = await this.covering(app);
    if (!database && !volumes) throw new NothingToBackUpBeforeDeploy();

    const result: PreDeployBackupResult = { applicationId: app.id };
    const context = { deployId: req.deployId, applicationId: app.id };

    if (database) {
      const engine = this.engines.forEngine(database.engine);
      if (engine.pointInTime !== false && engine.markRestorePoint) {
        result.restorePoint = await this.recordRestorePoint(
          app,
          database,
          req.deployId,
        );
      } else {
        const dump = await this.jobs.createOnDemand(
          database.userId,
          { policyId: database.id, metadata: context },
          BackupJobTriggerType.PRE_DEPLOY,
        );
        result.dumpJobId = dump.id;
      }
    }

    if (volumes) {
      const copy = await this.jobs.createOnDemand(
        volumes.userId,
        { policyId: volumes.id, metadata: context },
        BackupJobTriggerType.PRE_DEPLOY,
      );
      result.volumeJobId = copy.id;
    }

    this.logger.log(
      `[pre-deploy] ${app.slug}: ${[
        result.restorePoint ? `restore point ${result.restorePoint.at}` : '',
        result.dumpJobId ? `dump ${result.dumpJobId}` : '',
        result.volumeJobId ? `volume copy ${result.volumeJobId}` : '',
      ]
        .filter(Boolean)
        .join(', ')}`,
    );
    return result;
  }

  /** Turns the backup before each deploy on or off for one application. */
  async setOption(
    applicationId: string,
    option: { enabled: boolean; required?: boolean },
  ): Promise<BeforeDeployOption> {
    const app = await this.apps.findOne({ where: { id: applicationId } });
    if (!app) {
      throw new NotFoundException(`Application ${applicationId} not found`);
    }
    const required = option.enabled && option.required === true;
    await this.apps.update(app.id, {
      preDeploySnapshotEnabled: option.enabled,
      preDeploySnapshotPolicy: required ? 'required' : 'best_effort',
    });
    return this.describe({
      ...app,
      preDeploySnapshotEnabled: option.enabled,
      preDeploySnapshotPolicy: required ? 'required' : 'best_effort',
    } as ApplicationEntity);
  }

  async optionFor(applicationId: string): Promise<BeforeDeployOption | null> {
    const app = await this.apps.findOne({ where: { id: applicationId } });
    return app ? this.describe(app) : null;
  }

  private async describe(app: ApplicationEntity): Promise<BeforeDeployOption> {
    const { database, volumes } = await this.covering(app);
    const pointInTime = database
      ? this.engines.supports(database.engine) &&
        this.engines.forEngine(database.engine).pointInTime !== false
      : false;
    const takes = {
      restorePoint: !!database && pointInTime,
      dump: !!database && !pointInTime,
      volumes: !!volumes,
    };
    return {
      applicationId: app.id,
      enabled: app.preDeploySnapshotEnabled,
      required: app.preDeploySnapshotPolicy === 'required',
      takes,
      ...(app.preDeploySnapshotEnabled && !database && !volumes
        ? {
            warning:
              'No backup policy protects this application yet, so nothing will be taken before a deploy until one does.',
          }
        : {}),
    };
  }

  private async covering(app: ApplicationEntity): Promise<{
    database?: BackupPolicyEntity;
    volumes?: BackupPolicyEntity;
  }> {
    const covering = (await this.policies.findByCluster(app.clusterId)).filter(
      (p) => (p.scopeSelector?.applicationIds ?? []).includes(app.id),
    );
    return {
      database: covering.find(
        (p) => p.engineClass === BackupEngineClass.DATABASE,
      ),
      volumes: covering.find(
        (p) =>
          p.engineClass === BackupEngineClass.VOLUME_COPY &&
          p.enabled &&
          p.status === BackupPolicyStatus.ACTIVE,
      ),
    };
  }

  /**
   * The restore point is recorded as a run and an artifact of its own, with no
   * application id on the artifact: it names a moment inside the database's
   * existing backup, not a base, and must never be counted as one by retention
   * or picked as the base of a restore.
   */
  private async recordRestorePoint(
    app: ApplicationEntity,
    policy: BackupPolicyEntity,
    deployId: string,
  ): Promise<NonNullable<PreDeployBackupResult['restorePoint']>> {
    const engine = this.engines.forEngine(policy.engine);
    const startedAt = new Date();
    const mark = await engine.markRestorePoint!(app.id, deployId);
    const job = await this.jobRows.save(
      this.jobRows.create({
        clusterId: app.clusterId,
        userId: policy.userId,
        applicationId: app.id,
        triggerType: BackupJobTriggerType.PRE_DEPLOY,
        triggerContext: {
          deployId,
          applicationId: app.id,
          policyId: policy.id,
          kind: RESTORE_POINT_KIND,
        },
        status: BackupJobStatus.COMPLETED,
        startedAt,
        finishedAt: new Date(),
        scopeSnapshot: { applicationId: app.id },
        metadata: { restorePoint: mark },
      }),
    );
    const artifact = await this.artifacts.saveArtifact(
      this.artifacts.createArtifact({
        backupJobId: job.id,
        clusterId: app.clusterId,
        engineClass: BackupEngineClass.DATABASE,
        engine: policy.engine ?? engine.engine,
        manifestSummary: {
          kind: RESTORE_POINT_KIND,
          restorePointFor: app.id,
          applicationSlug: app.slug,
          policyId: policy.id,
          recoverTo: mark.at,
          ...(mark.position ? { position: mark.position } : {}),
          deployId,
        },
        metadata: {},
      }),
    );
    return {
      artifactId: artifact.id,
      at: mark.at,
      ...(mark.position ? { position: mark.position } : {}),
      engine: policy.engine ?? engine.engine,
    };
  }
}
