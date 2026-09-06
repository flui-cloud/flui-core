import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  forwardRef,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../entities/cluster.entity';
import { ApplicationEntity } from '../../../applications/entities/application.entity';
import { ApplicationStatus } from '../../../applications/enums/application-status.enum';
import { AppEndpointEntity } from '../../../dns/entities/app-endpoint.entity';
import { ReconciliationStatus } from '../../shared/enums/reconciliation-status.enum';
import { AppEndpointReconciliationService } from '../../../dns/services/app-endpoint-reconciliation.service';
import { EndpointModeResolverService } from '../../../dns/services/endpoint-mode-resolver.service';
import { ClusterDnsZoneEntity } from '../../../dns/entities/cluster-dns-zone.entity';
import { CatalogInstallEntity } from '../../../catalog/entities/catalog-install.entity';
import { BackupPolicyEntity } from '../../../backups/entities/backup-policy.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { ApplicationDeployService } from '../../../applications/services/application-deploy.service';
import { RebuildDataRestorer } from '../../../backups/services/rebuild-data-restorer.service';
import { BackupJobsService } from '../../../backups/services/backup-jobs.service';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';

const REACHABILITY_PROBE_MS = 20_000;
const DEPLOY_POLL_MS = 5_000;
const DEPLOY_WAIT_MS = 20 * 60_000;

/** Where an application got to. Read on a re-run to continue, not restart. */
export type RebuildPhase =
  | 'repointed'
  | 'restored'
  | 'deployed'
  | 'reconciled'
  | 'failed';

/** One endpoint's old and new name, decided before anything was mutated. */
export interface EndpointMove {
  from: string;
  to: string;
}

/** Keyed by endpoint id, so a resumed run reads the answer instead of re-deriving it. */
export type EndpointMoves = Record<string, EndpointMove>;

export interface RebuildResultApp {
  applicationId: string;
  name: string;
  phase: RebuildPhase | 'skipped';
  error?: string;
  /** Every name that changed, not the first: an application may publish several. */
  endpointMoved?: EndpointMove[];
  /** What came back thinner than the application had — per volume, in words. */
  notes?: string[];
}

export interface RebuildResult {
  from: string;
  to: string;
  apps: RebuildResultApp[];
  /** Schedules that named the lost cluster and now name the destination. */
  movedPolicies: string[];
  /** True when every application it tried reached `reconciled`. */
  complete: boolean;
}

/** One application's place in a rebuild, and everything true about it. */
export interface RebuildPlanApp {
  applicationId: string;
  name: string;
  slug: string;
  status: string;
  /** Set when this application cannot be rebuilt at all. */
  blocked?: string;
  /** True but not disqualifying — the user decides. */
  warnings: string[];
  /** What will come back, and from where. Empty is a fact, not an omission. */
  restores: string[];
  /** Where it got to on a previous run, when there was one. */
  phase?: string;
}

export interface RebuildPlan {
  from: { id: string; name: string; status: string };
  to: { id: string; name: string; status: string };
  apps: RebuildPlanApp[];
  /** Reasons the whole rebuild cannot start. Empty means it can. */
  refusals: string[];
  /** True of the whole rebuild, and not disqualifying. The person decides. */
  warnings: string[];
  capacity?: {
    requiredCpuMillis: number;
    requiredMemoryMi: number;
    availableCpuMillis: number;
    availableMemoryMi: number;
    fits: boolean;
  };
}

/**
 * Re-materialises the applications of a lost cluster onto a live one: the
 * records supply the shape, the backups the contents.
 *
 * Limits: only what Flui created, only the container and not what is inside
 * it, and it needs a live control plane.
 */
@Injectable()
export class ClusterRebuildService {
  private readonly logger = new Logger(ClusterRebuildService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly endpointRepo: Repository<AppEndpointEntity>,
    @InjectRepository(CatalogInstallEntity)
    private readonly catalogInstallRepo: Repository<CatalogInstallEntity>,
    @InjectRepository(BackupPolicyEntity)
    private readonly policyRepo: Repository<BackupPolicyEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepo: Repository<InfrastructureOperationEntity>,
    @InjectQueue('infrastructure') private readonly infrastructureQueue: Queue,
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @Inject(forwardRef(() => ApplicationDeployService))
    private readonly deploy: ApplicationDeployService,
    @Inject(forwardRef(() => RebuildDataRestorer))
    private readonly dataRestorer: RebuildDataRestorer,
    @Inject(forwardRef(() => BackupJobsService))
    private readonly backupJobs: BackupJobsService,
    @Inject(forwardRef(() => AppEndpointReconciliationService))
    private readonly endpointReconciliation: AppEndpointReconciliationService,
    @Inject(forwardRef(() => EndpointModeResolverService))
    private readonly endpointMode: EndpointModeResolverService,
    @InjectRepository(ClusterDnsZoneEntity)
    private readonly zoneAssignmentRepo: Repository<ClusterDnsZoneEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async plan(fromId: string, toId: string): Promise<RebuildPlan> {
    const from = await this.mustFindCluster(fromId, 'from');
    const to = await this.mustFindCluster(toId, 'to');
    const refusals: string[] = [];

    if (from.id === to.id) {
      refusals.push('A cluster cannot be rebuilt onto itself.');
    }
    if (to.clusterType === ClusterType.CONTROL) {
      refusals.push(
        'The control cluster runs the plane doing the rebuilding, and is not a ' +
          'destination for workloads.',
      );
    }
    if (to.status !== ClusterStatus.READY) {
      refusals.push(
        `The destination is ${to.status}, not ready. Applications can only be ` +
          'rebuilt onto a cluster that can accept them.',
      );
    }

    // A source that still answers is not lost, and moving a live cluster is a
    // migration: it drains rather than rebuilds, and the two must not be
    // confused by a command that assumes nothing is running.
    const sourceState = await this.probeSource(from);
    if (sourceState === 'answering') {
      refusals.push(
        `${from.name} is still reachable. A rebuild re-materialises what was ` +
          'lost; moving a working cluster is a migration, which drains it ' +
          'instead of recreating from records.',
      );
    }
    const warnings: string[] =
      sourceState === 'silent'
        ? [
            `${from.name} did not answer within ${REACHABILITY_PROBE_MS / 1000} ` +
              'seconds. That is what a cluster that is gone looks like, and also ' +
              'what one merely cut off from the control plane looks like — if it ' +
              'is the second, its applications are still running and still ' +
              'writing, and rebuilding makes a second copy of each.',
          ]
        : [];

    // Two sets, because `repoint` is the first thing a rebuild does and it
    // changes the very column this used to select on: an application that got
    // past step one vanished from the plan, and a rebuild that failed halfway
    // could never be resumed by the same command — which is the property the
    // phase ledger exists to provide. So: still on the source, or carrying a
    // ledger that names this destination.
    const apps = await this.appRepo
      .createQueryBuilder('a')
      .where('a."clusterId" = :fromId', { fromId: from.id })
      .orWhere(`a."metadata"::jsonb -> 'rebuild' ->> 'to' = :toId`, {
        toId: to.id,
      })
      .orderBy('a.name', 'ASC')
      .getMany();
    const planned = await Promise.all(
      apps.map((app) => this.planApp(app, to.id)),
    );

    const capacity = await this.planCapacity(to, apps).catch((err: Error) => {
      refusals.push(
        `The destination's capacity could not be read (${err.message}), so the ` +
          'whole set cannot be checked against it before starting.',
      );
      return undefined;
    });
    if (capacity && !capacity.fits) {
      refusals.push(
        `The destination does not have room for all ${apps.length} applications ` +
          `(needs ${capacity.requiredCpuMillis}m CPU and ${capacity.requiredMemoryMi}Mi, ` +
          `has ${capacity.availableCpuMillis}m and ${capacity.availableMemoryMi}Mi). ` +
          'Checked for the whole set, because a rebuild that fits app by app and ' +
          'runs out halfway leaves half a cluster.',
      );
    }

    return {
      from: { id: from.id, name: from.name, status: from.status },
      to: { id: to.id, name: to.name, status: to.status },
      apps: planned,
      refusals,
      warnings,
      capacity,
    };
  }

  /**
   * The plan runs here rather than in the job so a refusal reaches the person
   * who typed the command, not a log nobody is watching.
   */
  async start(
    userId: string,
    fromId: string,
    toId: string,
    opts: { includeStopped?: boolean } = {},
  ): Promise<InfrastructureOperationEntity> {
    const plan = await this.plan(fromId, toId);
    if (plan.refusals.length > 0) {
      throw new BadRequestException(plan.refusals.join(' '));
    }

    const from = await this.mustFindCluster(fromId, 'from');
    const to = await this.mustFindCluster(toId, 'to');
    const willAttempt = plan.apps.filter(
      (a) =>
        !a.blocked &&
        (a.status === ApplicationStatus.RUNNING || opts.includeStopped),
    );

    const operation = await this.operationRepo.save(
      this.operationRepo.create({
        operationType: OperationType.REBUILD_CLUSTER,
        status: OperationStatus.PENDING,
        resourceType: 'cluster',
        resourceName: from.name,
        resourceId: from.id,
        provider: to.provider as never,
        totalSteps: willAttempt.length,
        currentStepIndex: 0,
        currentStepProgress: 0,
        userId,
        metadata: {
          fromClusterId: from.id,
          fromClusterName: from.name,
          toClusterId: to.id,
          toClusterName: to.name,
          includeStopped: opts.includeStopped ?? false,
          apps: [],
          estimatedDurationInSeconds: 180 * Math.max(willAttempt.length, 1),
        },
      }),
    );

    await this.infrastructureQueue.add(
      'rebuild-cluster',
      {
        operationId: operation.id,
        userId,
        fromId: from.id,
        toId: to.id,
        includeStopped: opts.includeStopped ?? false,
      },
      { attempts: 1, timeout: 3_600_000 },
    );

    this.logger.log(
      `Queued rebuild of ${from.name} onto ${to.name} — ${willAttempt.length} application(s), operation ${operation.id}`,
    );
    return operation;
  }

  /**
   * One application at a time, recording where each got to. Never rolls back:
   * a partial rebuild is an honest state that a re-run continues from.
   */
  async execute(
    userId: string,
    fromId: string,
    toId: string,
    opts: {
      includeStopped?: boolean;
      onProgress?: (done: RebuildResultApp[]) => Promise<void>;
    } = {},
  ): Promise<RebuildResult> {
    const plan = await this.plan(fromId, toId);
    if (plan.refusals.length > 0) {
      throw new BadRequestException(plan.refusals.join(' '));
    }

    const from = await this.mustFindCluster(fromId, 'from');
    const to = await this.mustFindCluster(toId, 'to');
    // Stops it being offered as a deploy target while its applications move.
    await this.markLost(fromId);
    const results: RebuildResultApp[] = [];

    for (const planned of plan.apps) {
      if (planned.blocked) {
        results.push({
          applicationId: planned.applicationId,
          name: planned.name,
          phase: 'skipped',
          error: planned.blocked,
        });
        await opts.onProgress?.(results);
        continue;
      }
      if (
        planned.status !== ApplicationStatus.RUNNING &&
        !opts.includeStopped
      ) {
        results.push({
          applicationId: planned.applicationId,
          name: planned.name,
          phase: 'skipped',
          error: `was ${planned.status} when the cluster was lost`,
        });
        await opts.onProgress?.(results);
        continue;
      }

      results.push(
        await this.rebuildOne(userId, planned.applicationId, from, to),
      );
      await opts.onProgress?.(results);
    }

    const movedPolicies = await this.repointClusterWidePolicies(fromId, to.id);

    const attempted = results.filter((r) => r.phase !== 'skipped');
    return {
      from: plan.from.name,
      to: plan.to.name,
      apps: results,
      movedPolicies,
      complete:
        attempted.length > 0 &&
        attempted.every((r) => r.phase === 'reconciled'),
    };
  }

  /**
   * A cluster-scoped schedule cannot move with any single application, so it
   * moves once at the end. Left alone it keeps firing at a dead cluster and
   * the applications that just came back are protected by nothing.
   */
  private async repointClusterWidePolicies(
    fromId: string,
    toId: string,
  ): Promise<string[]> {
    const stranded = await this.policyRepo.find({
      where: { clusterId: fromId },
    });
    const moved: string[] = [];
    for (const policy of stranded) {
      await this.policyRepo.update({ id: policy.id }, { clusterId: toId });
      moved.push(`${policy.engineClass} schedule ${policy.id.slice(0, 8)}`);
    }
    if (moved.length > 0) {
      this.logger.log(
        `[rebuild] moved ${moved.length} schedule(s) off the lost cluster`,
      );
    }
    return moved;
  }

  /**
   * Re-pointed immediately before its own deploy, not for the whole set up
   * front: a failure partway then leaves the untouched ones honestly on the
   * lost cluster rather than claiming a destination they never reached.
   */
  private async rebuildOne(
    userId: string,
    applicationId: string,
    from: ClusterEntity,
    to: ClusterEntity,
  ): Promise<RebuildResultApp> {
    const app = await this.appRepo.findOne({ where: { id: applicationId } });
    if (!app) {
      return {
        applicationId,
        name: applicationId,
        phase: 'failed',
        error: 'the application row vanished mid-rebuild',
      };
    }
    const name = app.name;
    const phaseSoFar = this.phaseOf(app, to.id);
    let notes: string[] = [];

    try {
      if (!phaseSoFar) {
        // Writes its own phase: the decision and the phase that depends on it
        // commit together.
        await this.repoint(app, from, to, notes);
      }

      if (
        this.phaseRank(this.phaseOf(app, to.id)) < this.phaseRank('restored')
      ) {
        notes = [...notes, ...(await this.restoreData(app, to))];
        await this.setPhase(app, 'restored', to.id, undefined, notes);
      } else {
        notes = this.notesOf(app, to.id);
      }

      if (
        this.phaseRank(this.phaseOf(app, to.id)) < this.phaseRank('deployed')
      ) {
        const operation = await this.deploy.deploy(
          app.id,
          { useCurrentImage: true },
          userId,
        );
        await this.awaitDeploy(operation.id, name);
        await this.setPhase(app, 'deployed', to.id, undefined, notes);
      }

      // Only now: the pod already holds what it needed, and what would stay
      // on the row is a live credential for someone else's repository.
      await this.dataRestorer.forget(app.id);

      const endpointMoved = await this.repointEndpoints(app, from, to);

      // After the name, and allowed to fail the application: the image
      // neutralises `archive_command` when it restores, so a database that is
      // not re-armed comes back looking protected and shipping nothing. A note
      // on a `reconciled` application is a lie no re-run would ever revisit;
      // failing here keeps the phase at `deployed`, and the next run retries
      // this and only this.
      await this.rearmBackups(app, userId, notes);

      await this.setPhase(app, 'reconciled', to.id, undefined, notes);

      return {
        applicationId,
        name,
        phase: 'reconciled',
        endpointMoved,
        notes: notes.length > 0 ? notes : undefined,
      };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      // The phase reached is kept and the error recorded beside it. Writing
      // `failed` over it ranked the application at zero, so the next run redid
      // the restore and the deploy on one already running.
      await this.setPhase(
        app,
        this.phaseOf(app, to.id) ?? 'failed',
        to.id,
        message,
        notes,
      );
      this.logger.error(`[rebuild] ${name}: ${message}`);
      return {
        applicationId,
        name,
        phase: 'failed',
        error: message,
        notes: notes.length > 0 ? notes : undefined,
      };
    }
  }

  /**
   * The base backup is not optional. Every WAL segment written between the
   * restore and the re-arm went to a no-op and has been recycled, so the old
   * base and its logs stop at the rebuild: without one taken now, nothing can
   * recover any moment after it.
   */
  private async rearmBackups(
    app: ApplicationEntity,
    userId: string,
    notes: string[],
  ): Promise<void> {
    const policyId = await this.dataRestorer.rearm(app.id);
    if (!policyId) return;
    await this.backupJobs.createOnDemand(userId, { policyId });
    notes.push(
      'database: WAL shipping re-armed and a new base taken — the logs written ' +
        'while it was restoring were discarded and cannot be recovered from',
    );
  }

  /**
   * `deploy()` only queues. Marking the phase on its return would call an
   * application rebuilt before its pod exists, and hide every failure that
   * appears at rollout.
   */
  private async awaitDeploy(operationId: string, name: string): Promise<void> {
    const deadline = Date.now() + DEPLOY_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DEPLOY_POLL_MS));
      const operation = await this.operationRepo.findOne({
        where: { id: operationId },
      });
      if (!operation) continue;
      if (operation.status === OperationStatus.COMPLETED) return;
      if (
        operation.status === OperationStatus.FAILED ||
        operation.status === OperationStatus.CANCELLED
      ) {
        throw new Error(
          `the deploy ${operation.status.toLowerCase()}: ${operation.errorMessage ?? 'no reason recorded'}`,
        );
      }
    }
    throw new Error(
      `the deploy of ${name} had not finished after ${Math.round(DEPLOY_WAIT_MS / 60000)} minutes`,
    );
  }

  /**
   * Everything that names the lost cluster moves together — endpoints, catalog
   * install, backup policy — or what is left behind points at a dead cluster.
   */
  private async repoint(
    app: ApplicationEntity,
    from: ClusterEntity,
    to: ClusterEntity,
    notes: string[],
  ): Promise<EndpointMoves> {
    // Decided here, while the rows still name the source. Every column the
    // classification reads is one this method is about to overwrite.
    const moves = await this.planEndpointMoves(app, from, to);

    // Released while the row still names the record and the zone that owns it.
    for (const [endpointId, move] of Object.entries(moves)) {
      if (move.to === move.from) continue;
      await this.endpointReconciliation.releaseDnsRecord(endpointId);
    }

    const toZone = await this.destinationZoneFor(app, to);
    if (!toZone) {
      notes.push(
        'the destination has no assignment for this zone, so the published ' +
          'names were kept as they were',
      );
    }

    const catalogInstallId = (app.metadata as Record<string, string> | null)
      ?.catalogInstallId;
    const metadata = this.ledgerFor(app, 'repointed', to.id, {
      from: from.id,
      endpoints: moves,
    });

    // One transaction, because the phase and the facts the phase was decided
    // from must survive or fail together: a crash between them leaves an
    // endpoint already mutated and no record of what it used to be.
    await this.dataSource.transaction(async (tx: EntityManager) => {
      // A node name from the lost cluster would become a nodeSelector nothing
      // satisfies. The plan refuses these, so reaching here means it was cleared.
      await tx.update(
        ApplicationEntity,
        { id: app.id },
        {
          clusterId: to.id,
          dedicatedNodeName: null as never,
          metadata: metadata as never,
        },
      );

      for (const [endpointId, move] of Object.entries(moves)) {
        await tx.update(
          AppEndpointEntity,
          { id: endpointId },
          {
            clusterId: to.id,
            // Its fallback address for the zone reconciler is the dead master.
            ...(toZone ? { clusterDnsZoneId: toZone.id } : {}),
            ...this.invalidatedByMove(move),
          },
        );
      }

      if (catalogInstallId) {
        await tx.update(
          CatalogInstallEntity,
          { id: catalogInstallId },
          { clusterId: to.id },
        );
      }

      // Otherwise the application comes back and stops being backed up: the
      // schedule keeps firing at a machine that does not answer.
      await tx
        .createQueryBuilder()
        .update(BackupPolicyEntity)
        .set({ clusterId: to.id })
        .where(`"scopeSelector"->'applicationIds' @> :needle::jsonb`, {
          needle: JSON.stringify([app.id]),
        })
        .execute();
    });

    app.clusterId = to.id;
    app.dedicatedNodeName = null;
    app.metadata = metadata as ApplicationEntity['metadata'];
    return moves;
  }

  /**
   * Cleared whether or not the name changed. `reconcileDnsRecord` prefers a
   * stored `dnsRecordValue` over the cluster's own master address, so a value
   * left behind pins a custom domain to the lost cluster's IP — and the zone
   * sweep then defends it as the desired state. `app-migration` already drops
   * it for the same reason.
   */
  private invalidatedByMove(move: EndpointMove): Partial<AppEndpointEntity> {
    const common = {
      dnsRecordValue: null as never,
      reconciliationStatus: ReconciliationStatus.DRIFT,
    };
    if (move.to === move.from) return common;
    return {
      ...common,
      fqdn: move.to,
      // Everything else derived from the old name, so it is minted again.
      dnsRecordId: null as never,
      wildcardCertificateId: null,
      sanCertificateId: null,
      tlsSecretName: null as never,
      syncedDomain: null as never,
    };
  }

  /**
   * Neither shape leaves an application running on an empty volume: a database
   * boots recovering, a volume is filled before its container may start.
   */
  private async restoreData(
    app: ApplicationEntity,
    to: ClusterEntity,
  ): Promise<string[]> {
    const outcomes = await this.dataRestorer.restoreInto(app, to);
    for (const outcome of outcomes) {
      this.logger.log(
        outcome.kind === 'empty'
          ? `[rebuild] ${app.slug} ${outcome.what}: ${outcome.why}`
          : `[rebuild] ${app.slug} ${outcome.what}: recovering from ${outcome.from}`,
      );
    }
    return outcomes
      .filter((o) => o.kind === 'empty')
      .map((o) => `${o.what}: ${(o as { why: string }).why}`);
  }

  /**
   * A Flui-derived hostname names its cluster, so it cannot be carried over.
   * Computing the new one is not the job — writing it and reconciling is: an
   * earlier version returned the string and left both applications answering
   * at no hostname at all.
   */
  private async repointEndpoints(
    app: ApplicationEntity,
    from: ClusterEntity,
    to: ClusterEntity,
  ): Promise<RebuildResultApp['endpointMoved']> {
    const endpoints = await this.endpointRepo.find({
      where: { applicationId: app.id },
    });
    if (endpoints.length === 0) return undefined;

    // The ledger holds what `repoint` decided before it mutated anything. A run
    // whose repoint predates the ledger falls back to deciding now, which is
    // sound only because the source is passed in rather than read off the row.
    const moves =
      this.movesOf(app, to.id) ?? (await this.planEndpointMoves(app, from, to));
    // A resumed run skips `repoint`, so this can still name the lost cluster —
    // whose master is the zone reconciler's fallback address.
    const toZone = await this.destinationZoneFor(app, to);

    const moved: EndpointMove[] = [];
    for (const endpoint of endpoints) {
      const move = moves[endpoint.id] ?? {
        from: endpoint.fqdn,
        to: endpoint.fqdn,
      };
      // Whether the rename still has to happen, not whether one was decided:
      // on a first run `repoint` applied it already.
      const pending = endpoint.fqdn !== move.to;

      if (pending && move.to !== move.from) {
        // The old record first, while the row still names it.
        await this.endpointReconciliation.releaseDnsRecord(endpoint.id);
      }
      const zoneStale = !!toZone && endpoint.clusterDnsZoneId !== toZone.id;
      if (pending || endpoint.dnsRecordValue || zoneStale) {
        await this.endpointRepo.update(
          { id: endpoint.id },
          {
            ...this.invalidatedByMove(move),
            ...(zoneStale ? { clusterDnsZoneId: toZone.id } : {}),
          },
        );
      }
      if (move.to !== move.from) moved.push(move);

      // Not optional: without it the application answers at no name at all.
      await this.endpointReconciliation.reconcile(endpoint.id);
    }
    return moved.length > 0 ? moved : undefined;
  }

  /**
   * Only a name Flui derived is re-derived. A string replacement assumed
   * `<slug>.<cluster>.<two-label zone>` — the fixture's shape — and would
   * mangle a custom hostname, which is worse than leaving one that worked.
   *
   * The source is passed in, never read from the endpoint: `repoint` overwrites
   * both `clusterId` and `clusterDnsZoneId`, so a classification that consulted
   * them compared the destination's name against the source's and concluded
   * every generated hostname was a custom one.
   *
   * Known gap: `tenancySubdomain` is not reproduced here, so a tenancy name is
   * classified custom and kept. Safe, and visible in the result.
   */
  private async planEndpointMoves(
    app: ApplicationEntity,
    from: ClusterEntity,
    to: ClusterEntity,
  ): Promise<EndpointMoves> {
    const endpoints = await this.endpointRepo.find({
      where: { applicationId: app.id },
    });
    const toZone = await this.destinationZoneFor(app, to);
    const moves: EndpointMoves = {};

    for (const endpoint of endpoints) {
      moves[endpoint.id] = {
        from: endpoint.fqdn,
        to: await this.derivedTarget(endpoint, app, from, to, toZone),
      };
    }
    return moves;
  }

  /** The old name back means "not ours to rename". */
  private async derivedTarget(
    endpoint: AppEndpointEntity,
    app: ApplicationEntity,
    from: ClusterEntity,
    to: ClusterEntity,
    toZone: ClusterDnsZoneEntity | null,
  ): Promise<string> {
    if (!toZone) return endpoint.fqdn;
    try {
      const fromZone = await this.sourceZoneFor(endpoint, from);
      const derived = this.endpointMode.generateFqdn(
        endpoint.hostnameMode,
        app.slug,
        from,
        fromZone,
      );
      if (derived !== endpoint.fqdn) return endpoint.fqdn;
      return this.endpointMode.generateFqdn(
        endpoint.hostnameMode,
        app.slug,
        to,
        toZone,
      );
    } catch {
      // `generateFqdn` refuses rather than guesses; keeping the name is the
      // safe half of that refusal.
      return endpoint.fqdn;
    }
  }

  /**
   * The endpoint's own assignment when it still names the source, otherwise the
   * source's assignment for the same zone — never "any assignment on that
   * cluster", which picks arbitrarily when a cluster serves several.
   */
  private async sourceZoneFor(
    endpoint: AppEndpointEntity,
    from: ClusterEntity,
  ): Promise<ClusterDnsZoneEntity | null> {
    const recorded = endpoint.clusterDnsZoneId
      ? await this.zoneAssignmentRepo.findOne({
          where: { id: endpoint.clusterDnsZoneId },
          relations: ['dnsZone'],
        })
      : null;
    if (recorded?.clusterId === from.id) return recorded;

    const zoneName = recorded?.dnsZone?.zoneName;
    if (!zoneName) return recorded;
    const assignments = await this.zoneAssignmentRepo.find({
      where: { clusterId: from.id },
      relations: ['dnsZone'],
    });
    return (
      assignments.find((a) => a.dnsZone?.zoneName === zoneName) ?? recorded
    );
  }

  /** Matched on the zone the endpoint already publishes under, not on order. */
  private async destinationZoneFor(
    app: ApplicationEntity,
    to: ClusterEntity,
  ): Promise<ClusterDnsZoneEntity | null> {
    const assignments = await this.zoneAssignmentRepo.find({
      where: { clusterId: to.id },
      relations: ['dnsZone'],
    });
    if (assignments.length <= 1) return assignments[0] ?? null;

    const endpoints = await this.endpointRepo.find({
      where: { applicationId: app.id },
    });
    for (const endpoint of endpoints) {
      const match = assignments.find(
        (a) =>
          a.dnsZone?.zoneName &&
          endpoint.fqdn.endsWith(`.${a.dnsZone.zoneName}`),
      );
      if (match) return match;
    }
    return assignments[0] ?? null;
  }

  /**
   * Scoped to the destination the ledger names. A cluster rebuilt once carries
   * `reconciled` forever, and read without that check a second rebuild — onto a
   * different cluster — looked like a resume of the first: `repoint` skipped,
   * so the application stayed on the cluster that had just been lost.
   */
  private phaseOf(
    app: ApplicationEntity,
    toId?: string,
  ): RebuildPhase | undefined {
    return this.ledgerOf(app, toId)?.phase;
  }

  private ledgerOf(
    app: ApplicationEntity,
    toId?: string,
  ):
    | {
        phase?: RebuildPhase;
        to?: string;
        endpoints?: EndpointMoves;
        notes?: string[];
      }
    | undefined {
    const ledger = (app.metadata as Record<string, unknown> | undefined)
      ?.rebuild as
      | {
          phase?: RebuildPhase;
          to?: string;
          endpoints?: EndpointMoves;
          notes?: string[];
        }
      | undefined;
    if (!ledger) return undefined;
    if (toId && ledger.to && ledger.to !== toId) return undefined;
    return ledger;
  }

  private phaseRank(phase?: RebuildPhase | 'skipped'): number {
    switch (phase) {
      case 'repointed':
        return 1;
      case 'restored':
        return 2;
      case 'deployed':
        return 3;
      case 'reconciled':
        return 4;
      default:
        return 0;
    }
  }

  private notesOf(app: ApplicationEntity, toId?: string): string[] {
    return this.ledgerOf(app, toId)?.notes ?? [];
  }

  /**
   * One column by id, never the entity: this object was loaded at the start of
   * the turn and everything since wrote through its own copy. Saving it whole
   * put a live S3 credential back on both applications after `forget()`.
   */
  private async setPhase(
    app: ApplicationEntity,
    phase: RebuildPhase,
    toId: string,
    error?: string,
    notes?: string[],
  ): Promise<void> {
    const fresh = await this.appRepo.findOne({
      where: { id: app.id },
      select: { id: true, metadata: true } as never,
    });
    if (fresh?.metadata) app.metadata = fresh.metadata;
    const metadata = this.ledgerFor(app, phase, toId, { error, notes });
    await this.appRepo.update({ id: app.id }, { metadata: metadata as never });
    // Kept in step so the phase checks in `rebuildOne` read what was written.
    app.metadata = metadata as ApplicationEntity['metadata'];
  }

  /**
   * Rewritten whole at every phase, so what `repoint` decided is carried
   * forward explicitly — a blind merge would also carry a failed run's `error`
   * into the phases that came after it.
   */
  private ledgerFor(
    app: ApplicationEntity,
    phase: RebuildPhase,
    toId: string,
    extra: {
      from?: string;
      endpoints?: EndpointMoves;
      error?: string;
      notes?: string[];
    },
  ): Record<string, unknown> {
    const metadata = ((app.metadata ?? {}) as Record<string, unknown>) ?? {};
    const previous = (metadata.rebuild ?? {}) as {
      from?: string;
      endpoints?: EndpointMoves;
    };
    const from = extra.from ?? previous.from;
    const endpoints = extra.endpoints ?? previous.endpoints;
    metadata.rebuild = {
      to: toId,
      phase,
      at: new Date().toISOString(),
      ...(from ? { from } : {}),
      ...(endpoints ? { endpoints } : {}),
      ...(extra.notes?.length ? { notes: extra.notes } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    };
    return metadata;
  }

  private movesOf(
    app: ApplicationEntity,
    toId?: string,
  ): EndpointMoves | undefined {
    return this.ledgerOf(app, toId)?.endpoints;
  }

  /** What stops it, separated from what the person should know first. */
  private async planApp(
    app: ApplicationEntity,
    toId: string,
  ): Promise<RebuildPlanApp> {
    const warnings: string[] = [];
    let blocked: string | undefined;

    // Left in place it becomes a nodeSelector nothing satisfies, and the pod
    // waits forever instead of failing.
    if (app.dedicatedNodeName) {
      blocked =
        `pinned to node "${app.dedicatedNodeName}", which does not exist on the ` +
        'destination';
    }

    if (app.status !== ApplicationStatus.RUNNING) {
      warnings.push(
        `was ${app.status}, not running, when the cluster was lost — skipped ` +
          'unless asked for',
      );
    }
    if (app.persistenceScope === 'dedicated') {
      warnings.push(
        'stores on the node-local class: the destination must have `flui-local`, ' +
          'or its claims never bind',
      );
    }

    // The same code that will do it, so the plan cannot promise data the
    // rebuild does not restore. Both halves: silence used to mean both "this
    // comes back" and "there is no data", on the screen where that is the
    // whole question.
    const restores: string[] = [];
    for (const outcome of await this.dataRestorer.preview(app)) {
      if (outcome.kind === 'empty') {
        warnings.push(`${outcome.what}: ${outcome.why}`);
      } else {
        restores.push(`${outcome.what}: from ${outcome.from}`);
      }
    }

    return {
      applicationId: app.id,
      name: app.name,
      slug: app.slug,
      status: app.status,
      blocked,
      warnings,
      restores,
      phase: this.phaseOf(app, toId),
    };
  }

  /**
   * Summed for the whole set: each may fit alone while the set does not, and
   * the rebuild would discover it with half the applications moved.
   */
  private async planCapacity(
    to: ClusterEntity,
    apps: ApplicationEntity[],
  ): Promise<RebuildPlan['capacity']> {
    if (!to.kubeconfigEncrypted) {
      throw new Error('the destination has no kubeconfig');
    }
    const kubeconfig = this.encryption.decrypt(to.kubeconfigEncrypted);
    // Millicores and MiB already. Converting again read a 2-core node as
    // 2000000m and a 3.7Gi one as 0Mi, refusing every rebuild.
    const allocatable = await this.k8s.getNodeAllocatable(kubeconfig);
    // Allocatable is the size of the cluster, not the room in it.
    const requested = await this.k8s.getPodResourceRequests(kubeconfig);

    let cpu = 0;
    let memory = 0;
    for (const app of apps) {
      const r = app.resources as
        | { cpu?: { request?: string }; memory?: { limit?: string } }
        | undefined;
      cpu += parseCpuMillis(r?.cpu?.request) * (app.replicas ?? 1);
      memory += parseMemoryMi(r?.memory?.limit) * (app.replicas ?? 1);
    }

    const availableCpuMillis = Math.max(allocatable.cpu - requested.cpu, 0);
    const availableMemoryMi = Math.max(
      allocatable.memory - requested.memory,
      0,
    );
    return {
      requiredCpuMillis: cpu,
      requiredMemoryMi: memory,
      availableCpuMillis,
      availableMemoryMi,
      fits: cpu <= availableCpuMillis && memory <= availableMemoryMi,
    };
  }

  /**
   * A call that throws, not a listing: `[]` means the same for an unreachable
   * cluster and an empty one. Bounded, because a powered-off host swallows the
   * packets and the kernel takes 133s to give up — measured.
   *
   * `refused` is proof the cluster is not serving. `silent` is not: a
   * partitioned control plane sees the same thing while the applications there
   * keep writing, so the caller is told which it got.
   */
  private async probeSource(
    cluster: ClusterEntity,
  ): Promise<'answering' | 'refused' | 'silent'> {
    if (!cluster.kubeconfigEncrypted) return 'refused';
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'silent'>((resolve) => {
      timer = setTimeout(() => resolve('silent'), REACHABILITY_PROBE_MS);
    });
    try {
      return await Promise.race([
        this.k8s
          .getNodeAllocatable(kubeconfig)
          .then(() => 'answering' as const)
          .catch(() => 'refused' as const),
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** `DELETED` would claim a decision nobody made; `READY` keeps it in every
   * deploy picker. */
  private async markLost(clusterId: string): Promise<void> {
    await this.clusterRepo.update(
      { id: clusterId },
      { status: ClusterStatus.LOST },
    );
  }

  private async mustFindCluster(
    id: string,
    side: 'from' | 'to',
  ): Promise<ClusterEntity> {
    const cluster = await this.clusterRepo.findOne({ where: { id } });
    if (!cluster) {
      throw new BadRequestException(`No cluster ${id} for --${side}`);
    }
    return cluster;
  }
}

function parseCpuMillis(value?: string): number {
  if (!value) return 0;
  return value.endsWith('m')
    ? Number.parseInt(value, 10)
    : Math.round(Number.parseFloat(value) * 1000);
}

function parseMemoryMi(value?: string): number {
  if (!value) return 0;
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?$/.exec(value.trim());
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  switch (m[2]) {
    case 'Ki':
      return Math.round(n / 1024);
    case 'Gi':
      return Math.round(n * 1024);
    case 'Ti':
      return Math.round(n * 1024 * 1024);
    default:
      return Math.round(n);
  }
}
