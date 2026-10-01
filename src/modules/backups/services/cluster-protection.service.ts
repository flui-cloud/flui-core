import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import {
  BackupClusterProtectionEntity,
  ProtectedAppOutcome,
} from '../entities/backup-cluster-protection.entity';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BACKUP_JOB_TYPES, BACKUP_QUEUE } from '../backups.constants';
import {
  AppProtectionPlan,
  DB_ENGINE_LABEL,
  declaredEngineOf,
  planAppProtection,
} from '../utils/cluster-protection.plan';
import {
  ClusterProtectionView,
  ProtectClusterInput,
  ProtectedAppView,
  ReconcileOptions,
  ReconcileResult,
  isRecentFailure,
  withClusterLock,
  outcomesStillOnCluster,
  outcomeWithoutPolicy,
  protectionPolicyDto,
  toProtectionView,
} from '../utils/cluster-protection.util';
import { BackupPoliciesService } from './backup-policies.service';
import { BackupJobsService } from './backup-jobs.service';
import { DestinationPlacementValidator } from './destination-placement.validator';
import { DeclaredEngineResolver } from './declared-engine.resolver';
import { ClusterDecisionsService, coverOf } from './cluster-decisions.service';

export type {
  ClusterProtectionView,
  ProtectClusterInput,
  ProtectedAppView,
  ReconcileOptions,
  ReconcileResult,
} from '../utils/cluster-protection.util';

const GONE_CLUSTERS = new Set([ClusterStatus.DELETED, ClusterStatus.LOST]);
const GONE_APPS = [ApplicationStatus.DELETING, ApplicationStatus.DELETED];

/**
 * "Protect this cluster": one backup policy per application, with the engine
 * that fits it, for the applications there now and every one installed later.
 *
 * The row is the promise and the policies are ordinary ones: stopping the
 * protection keeps them, and deleting one of them is a person's decision the
 * next pass respects only as long as the protection is off — while it is on, an
 * application without a policy gets one again.
 */
@Injectable()
export class ClusterProtectionService {
  private readonly logger = new Logger(ClusterProtectionService.name);

  constructor(
    @InjectRepository(BackupClusterProtectionEntity)
    private readonly protections: Repository<BackupClusterProtectionEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    @InjectRepository(BackupPolicyEntity)
    private readonly policyRows: Repository<BackupPolicyEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly ops: Repository<InfrastructureOperationEntity>,
    private readonly destinations: BackupDestinationRepository,
    private readonly policies: BackupPoliciesService,
    private readonly jobs: BackupJobsService,
    private readonly placement: DestinationPlacementValidator,
    private readonly declaredEngines: DeclaredEngineResolver,
    private readonly decisions: ClusterDecisionsService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(BACKUP_QUEUE) private readonly queue: Queue,
  ) {}

  async start(
    userId: string,
    clusterId: string,
    input: ProtectClusterInput,
  ): Promise<{ operationId: string; protection: ClusterProtectionView }> {
    await this.liveCluster(clusterId);
    await this.assertDestination(userId, clusterId, input.destinationId);
    if (input.replicaDestinationId) {
      if (input.replicaDestinationId === input.destinationId) {
        throw new BadRequestException(
          'The replica must be a different destination from the primary.',
        );
      }
      await this.assertDestination(
        userId,
        clusterId,
        input.replicaDestinationId,
      );
    }
    await this.upsert(userId, clusterId, input);

    const op = await this.ops.save(
      this.ops.create({
        operationType: OperationType.BACKUP_QUICK_SETUP,
        status: OperationStatus.PENDING,
        resourceType: 'cluster',
        resourceId: clusterId,
        userId,
        metadata: { destinationId: input.destinationId, kind: 'protect' },
        totalSteps: 2,
      }),
    );
    await this.queue.add(
      BACKUP_JOB_TYPES.PROTECT_CLUSTER,
      {
        clusterId,
        operationId: op.id,
        runFirstBackup: input.runFirstBackup ?? true,
      },
      { attempts: 1, removeOnComplete: true },
    );
    return { operationId: op.id, protection: await this.view(clusterId) };
  }

  /** Records the promise, or updates it. Existing policies are left as they are. */
  async upsert(
    userId: string,
    clusterId: string,
    input: ProtectClusterInput,
  ): Promise<BackupClusterProtectionEntity> {
    const existing = await this.protections.findOne({ where: { clusterId } });
    const row =
      existing ?? this.protections.create({ clusterId, applications: {} });
    row.userId = userId;
    row.destinationId = input.destinationId;
    row.replicaDestinationId = input.replicaDestinationId ?? null;
    row.cronSchedule = input.cronSchedule?.trim() || null;
    row.retentionDays = input.retentionDays ?? row.retentionDays ?? 30;
    row.beforeDeploy = input.beforeDeploy ?? row.beforeDeploy ?? false;
    return this.protections.save(row);
  }

  /** Applications installed from now on are no longer protected automatically. */
  async stop(clusterId: string): Promise<{ stopped: boolean }> {
    const res = await this.protections.delete({ clusterId });
    return { stopped: (res.affected ?? 0) > 0 };
  }

  async view(clusterId: string): Promise<ClusterProtectionView> {
    const [row, needsDecision] = await Promise.all([
      this.protections.findOne({ where: { clusterId } }),
      this.decisions.forCluster(clusterId),
    ]);
    const names = row
      ? await this.appNames(Object.keys(row.applications ?? {}))
      : new Map<string, string>();
    return toProtectionView(clusterId, row, needsDecision, names);
  }

  async protectedClusterIds(): Promise<string[]> {
    const rows = await this.protections.find({ select: { clusterId: true } });
    return rows.map((r) => r.clusterId);
  }

  /** A new application on a protected cluster gets its policy without waiting for the sweep. */
  async protectApplication(applicationId: string): Promise<void> {
    const app = await this.apps.findOne({ where: { id: applicationId } });
    if (!app) return;
    await this.reconcile(app.clusterId, {
      onlyAppIds: [applicationId],
      runFirstBackup: true,
    });
  }

  /**
   * One pass over a protected cluster: every application without a policy is
   * given the one its plan says. Idempotent — an application a policy already
   * covers is left alone — and serialised per cluster, so the sweep, a deploy
   * and a person asking cannot create the same policy twice.
   */
  async reconcile(
    clusterId: string,
    opts: ReconcileOptions = {},
  ): Promise<ReconcileResult | null> {
    return withClusterLock(this.dataSource, clusterId, !!opts.waitForLock, () =>
      this.reconcileLocked(clusterId, opts),
    );
  }

  private async reconcileLocked(
    clusterId: string,
    opts: ReconcileOptions,
  ): Promise<ReconcileResult | null> {
    const row = await this.protections.findOne({ where: { clusterId } });
    if (!row) return null;
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster || GONE_CLUSTERS.has(cluster.status)) return null;

    const destination = await this.destinations.findById(row.destinationId);
    const apps = (
      await this.apps.find({
        where: {
          clusterId,
          deletedAt: IsNull(),
          status: Not(In(GONE_APPS)),
        },
        order: { createdAt: 'ASC' },
      })
    ).filter((a) => !opts.onlyAppIds || opts.onlyAppIds.includes(a.id));
    const policies = await this.policyRows.find({ where: { clusterId } });
    const outcomes: Record<string, ProtectedAppOutcome> = {
      ...row.applications,
    };
    const now = Date.now();
    const done: ProtectedAppView[] = [];

    for (const app of apps) {
      const previous = outcomes[app.id];
      const outcome =
        !opts.onlyAppIds && isRecentFailure(previous, now)
          ? previous
          : await this.protectOne(
              app,
              await this.plan(app, policies),
              row,
              destination,
              !!opts.runFirstBackup,
            );
      outcomes[app.id] = outcome;
      const view = { applicationId: app.id, name: app.name, ...outcome };
      done.push(view);
      await opts.onProgress?.(done.length, apps.length, view);
    }

    const live = opts.onlyAppIds
      ? outcomes
      : outcomesStillOnCluster(outcomes, apps);
    await this.protections.update(row.id, {
      applications: live,
      lastReconciledAt: new Date(),
    });
    return { applications: done };
  }

  private async plan(
    app: ApplicationEntity,
    policies: BackupPolicyEntity[],
  ): Promise<AppProtectionPlan> {
    let labels = app.labels;
    if (
      !declaredEngineOf(app) &&
      app.kind === ApplicationKind.DATABASE &&
      app.status === ApplicationStatus.RUNNING
    ) {
      const declared = await this.declaredEngines.resolveForApp(app.id);
      if (declared) labels = { ...labels, [DB_ENGINE_LABEL]: declared };
    }
    return planAppProtection(
      { ...app, labels },
      coverOf(app.id, policies),
      this.decisions.support(),
    );
  }

  private async protectOne(
    app: ApplicationEntity,
    plan: AppProtectionPlan,
    row: BackupClusterProtectionEntity,
    destination: BackupDestinationEntity | null,
    runFirstBackup: boolean,
  ): Promise<ProtectedAppOutcome> {
    const at = new Date().toISOString();
    const settled = outcomeWithoutPolicy(plan, at);
    if (settled) return settled;
    if (!destination) {
      return {
        outcome: 'failed',
        reason: 'the destination this cluster is protected to no longer exists',
        at,
      };
    }
    try {
      if (plan.kind === 'database') {
        if (app.status !== ApplicationStatus.RUNNING) {
          return {
            outcome: 'waiting',
            reason: 'the database is not running yet',
            engine: plan.engine,
            at,
          };
        }
        const policy = await this.policies.enableDatabase(
          row.userId,
          protectionPolicyDto(app, row, BackupEngineClass.DATABASE, false),
          destination,
          plan.engine,
        );
        // The shipped log replays onto a base: without one nothing restores.
        await this.jobs.createOnDemand(row.userId, { policyId: policy.id });
        await this.markBeforeDeploy(app, row);
        return {
          outcome: 'protected',
          policyId: policy.id,
          engine: policy.engine,
          engineClass: BackupEngineClass.DATABASE,
          at,
        };
      }
      const policy = await this.policies.create(
        row.userId,
        protectionPolicyDto(app, row, BackupEngineClass.VOLUME_COPY, true),
      );
      if (runFirstBackup) {
        await this.jobs.createOnDemand(row.userId, { policyId: policy.id });
      }
      await this.markBeforeDeploy(app, row);
      return {
        outcome: 'protected',
        policyId: policy.id,
        engine: 'kopia',
        engineClass: BackupEngineClass.VOLUME_COPY,
        at,
      };
    } catch (err: any) {
      const reason = err?.response?.message ?? err?.message ?? String(err);
      this.logger.warn(
        `[protect-cluster] ${app.slug} on ${app.clusterId} not protected: ${reason}`,
      );
      return {
        outcome: 'failed',
        reason: String(reason).slice(0, 500),
        engine: plan.kind === 'database' ? plan.engine : undefined,
        at,
      };
    }
  }

  private async markBeforeDeploy(
    app: ApplicationEntity,
    row: BackupClusterProtectionEntity,
  ): Promise<void> {
    if (!row.beforeDeploy || app.preDeploySnapshotEnabled) return;
    await this.apps.update(app.id, { preDeploySnapshotEnabled: true });
  }

  private async liveCluster(clusterId: string): Promise<ClusterEntity> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster || GONE_CLUSTERS.has(cluster.status)) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }
    return cluster;
  }

  private async assertDestination(
    userId: string,
    clusterId: string,
    destinationId: string,
  ): Promise<void> {
    const dest = await this.destinations.findById(destinationId);
    if (dest?.userId !== userId) {
      throw new NotFoundException(`Destination ${destinationId} not found`);
    }
    await this.placement.assertOffProvider(clusterId, destinationId);
  }

  private async appNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.apps.find({
      where: { id: In(ids) },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}
