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
import { Repository } from 'typeorm';
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
import { CatalogInstallEntity } from '../../../catalog/entities/catalog-install.entity';
import { BackupPolicyEntity } from '../../../backups/entities/backup-policy.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { ApplicationDeployService } from '../../../applications/services/application-deploy.service';
import { RebuildDataRestorer } from '../../../backups/services/rebuild-data-restorer.service';
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

export interface RebuildResultApp {
  applicationId: string;
  name: string;
  phase: RebuildPhase | 'skipped';
  error?: string;
  /** Only when the name had to change, which it does whenever it names the cluster. */
  endpointMoved?: { from: string; to: string };
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
 * Re-materialises the applications of a lost cluster onto a live one.
 *
 * The records are the source: `ApplicationEntity` carries env, volumes, config,
 * resources, scaling, exposure and placement, and the manifest generator
 * rebuilds every Kubernetes object from that row — which is what a redeploy
 * already does. Backups supply the *contents*; the records supply the shape.
 *
 * Three declared limits: it covers only what Flui created, it rebuilds the
 * container and not what is inside it, and it needs a live control plane.
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
    @Inject(forwardRef(() => AppEndpointReconciliationService))
    private readonly endpointReconciliation: AppEndpointReconciliationService,
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

    const apps = await this.appRepo.find({
      where: { clusterId: from.id },
      order: { name: 'ASC' },
    });
    const planned = await Promise.all(apps.map((app) => this.planApp(app)));

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
   * Queues the rebuild and hands back the operation to follow.
   *
   * The plan runs here rather than in the job so a refusal reaches the person
   * who typed the command, instead of becoming a failure four minutes deep in
   * something nobody is watching.
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
   * Moves the applications, one at a time, and records where each one got to.
   *
   * Never rolls back. Ten applications running on recovered data are not
   * undone to make a table look tidy; the nine still on the lost cluster are
   * an honest state that a re-run continues from.
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

    const to = await this.mustFindCluster(toId, 'to');
    // The precondition has just been proven: the source did not answer. Saying
    // so stops it being offered as a deploy target while its applications are
    // being moved off it, which `READY` would keep doing.
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

      results.push(await this.rebuildOne(userId, planned.applicationId, to));
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
   * Schedules that named the cluster rather than an application.
   *
   * `repoint` moves a policy that names the application it is moving, which
   * covers a database's own. It cannot move one whose scope is the cluster —
   * "everything here" — because at that point most of "everything" has not
   * moved yet. So it happens once, at the end.
   *
   * Left alone these keep firing against a cluster that does not answer, and
   * the applications that just came back are no longer protected by anything.
   * That was true after the first real rebuild: the volume-copy schedule stayed
   * on the lost cluster, enabled, while its application ran on the new one.
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
   * One application, in the order that leaves nothing half-true.
   *
   * The row is re-pointed immediately before its own deploy rather than for
   * the whole set up front: a failure partway then leaves the untouched ones
   * still on the lost cluster, which is true, instead of pointing at a
   * destination they were never deployed to — which the hourly reconciler
   * would read as drift on every one of them.
   */
  private async rebuildOne(
    userId: string,
    applicationId: string,
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
    const phaseSoFar = this.phaseOf(app);
    let notes: string[] = [];

    try {
      if (!phaseSoFar) {
        await this.repoint(app, to);
        await this.setPhase(app, 'repointed', to.id);
      }

      if (this.phaseRank(this.phaseOf(app)) < this.phaseRank('restored')) {
        notes = await this.restoreData(app, to);
        await this.setPhase(app, 'restored', to.id, undefined, notes);
      } else {
        notes = this.notesOf(app);
      }

      if (this.phaseRank(this.phaseOf(app)) < this.phaseRank('deployed')) {
        const operation = await this.deploy.deploy(
          app.id,
          { useCurrentImage: true },
          userId,
        );
        await this.awaitDeploy(operation.id, name);
        await this.setPhase(app, 'deployed', to.id, undefined, notes);
      }

      // Only now, and only because the pod already holds what it needed: what
      // stays on the row otherwise is a live credential for someone else's
      // repository, for as long as the application exists.
      await this.dataRestorer.forget(app.id);

      const endpointMoved = await this.repointEndpoints(app, to);
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
      await this.setPhase(app, 'failed', to.id, message);
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
   * Waits for the deploy to actually land before calling the application moved.
   *
   * `deploy()` queues and returns an operation. Marking the phase on the return
   * would report an application as rebuilt while its pod has not been created,
   * hand the next one a capacity reading taken before this one landed, and hide
   * the failures that only appear at rollout — a missing storage class, an
   * image the destination cannot pull, a restore that did not find its bucket.
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
   * Everything that names the lost cluster, moved together.
   *
   * The application alone is not enough: its endpoints, its catalog install and
   * its backup policy all carry a `clusterId`, and one left behind points at a
   * cluster that no longer answers.
   */
  private async repoint(
    app: ApplicationEntity,
    to: ClusterEntity,
  ): Promise<void> {
    // A node name from the lost cluster would become a nodeSelector nothing
    // satisfies. The plan refuses these, so reaching here means it was cleared.
    app.clusterId = to.id;
    app.dedicatedNodeName = null;
    await this.appRepo.save(app);

    await this.endpointRepo.update(
      { applicationId: app.id },
      { clusterId: to.id },
    );

    const catalogInstallId = (app.metadata as Record<string, string> | null)
      ?.catalogInstallId;
    if (catalogInstallId) {
      await this.catalogInstallRepo.update(
        { id: catalogInstallId },
        { clusterId: to.id },
      );
    }

    // The one that would otherwise undo the recovery: a policy left pointing at
    // the lost cluster keeps scheduling jobs against a machine that does not
    // answer, so the application comes back and stops being backed up.
    await this.policyRepo
      .createQueryBuilder()
      .update()
      .set({ clusterId: to.id })
      .where(`"scopeSelector"->'applicationIds' @> :needle::jsonb`, {
        needle: JSON.stringify([app.id]),
      })
      .execute();
  }

  /**
   * Puts the data where the workload will look for it, before it looks.
   *
   * Two shapes, and neither leaves an application running on an empty volume:
   * a database is booted in restore mode, so its first start reads recovered
   * data rather than initialising a new directory; a plain volume is restored
   * into a claim named exactly what the workload is about to ask for, so the
   * deploy adopts it instead of creating an empty one.
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
   * Re-points the endpoint rows and lets the reconciler do the rest.
   *
   * The hostname is not preserved, and cannot be: `generateFqdn` builds
   * `<slug>.<cluster>.<zone>`, so a name carried over would announce a cluster
   * the application no longer runs on. The new name is reported rather than
   * assumed to be guessable.
   *
   * Computing it is not the job — writing it is. An earlier version returned
   * the string and did nothing with it, and a rebuild that reported two
   * applications reconciled left both answering at no hostname at all.
   */
  private async repointEndpoints(
    app: ApplicationEntity,
    to: ClusterEntity,
  ): Promise<RebuildResultApp['endpointMoved']> {
    const endpoints = await this.endpointRepo.find({
      where: { applicationId: app.id },
    });
    if (endpoints.length === 0) return undefined;

    let moved: RebuildResultApp['endpointMoved'];
    for (const endpoint of endpoints) {
      const before = endpoint.fqdn;
      const after = before.replace(
        /\.[^.]+\.(?=[^.]+\.[^.]+$)/,
        `.${to.name}.`,
      );

      if (after !== before) {
        // The old name at the DNS provider first, while the row still says
        // what it was: left behind it answers with the address of a machine
        // that is gone.
        await this.endpointReconciliation.releaseDnsRecord(endpoint.id);
        await this.endpointRepo.update(
          { id: endpoint.id },
          {
            fqdn: after,
            // Everything derived from the old name, so the reconciler mints it
            // again rather than reusing a record and a certificate issued for
            // a hostname that no longer exists.
            dnsRecordId: null as never,
            dnsRecordValue: null as never,
            wildcardCertificateId: null,
            sanCertificateId: null,
            reconciliationStatus: ReconciliationStatus.DRIFT,
          },
        );
        moved ??= { from: before, to: after };
      }

      // Not optional, and the reason the whole step exists: without it the
      // application runs on the destination and answers at no name at all —
      // no record, no Ingress. Observed on the first real rebuild, which
      // reported success with both applications unreachable.
      await this.endpointReconciliation.reconcile(endpoint.id);
    }
    return moved;
  }

  private phaseOf(app: ApplicationEntity): RebuildPhase | undefined {
    const ledger = (app.metadata as Record<string, unknown> | undefined)
      ?.rebuild as { phase?: RebuildPhase } | undefined;
    return ledger?.phase;
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

  private notesOf(app: ApplicationEntity): string[] {
    const ledger = (app.metadata as Record<string, unknown> | undefined)
      ?.rebuild as { notes?: string[] } | undefined;
    return ledger?.notes ?? [];
  }

  /**
   * Writes the ledger and nothing else.
   *
   * One column, by id, rather than saving the entity: the object this holds was
   * loaded at the start of the application's turn, and everything since — the
   * restore declaration, the deploy, the sweep that takes the restore
   * credentials back off — has written to that row through its own copy. Saving
   * the whole entity here put every one of those back.
   *
   * That is not theoretical. `forget()` ran, cleaned the row, and the next
   * `setPhase` restored a live S3 credential onto both rebuilt applications;
   * the row was found still carrying it after a rebuild that reported success.
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
    const metadata = (fresh?.metadata ?? app.metadata ?? {}) as Record<
      string,
      unknown
    > as Record<string, unknown>;
    metadata.rebuild = {
      to: toId,
      phase,
      at: new Date().toISOString(),
      ...(notes?.length ? { notes } : {}),
      ...(error ? { error } : {}),
    };
    await this.appRepo.update({ id: app.id }, { metadata: metadata as never });
    // Kept in step so the phase checks in `rebuildOne` read what was written.
    app.metadata = metadata as ApplicationEntity['metadata'];
  }

  /**
   * What is true about one application, separated into what stops it and what
   * the person needs to know before saying yes.
   */
  private async planApp(app: ApplicationEntity): Promise<RebuildPlanApp> {
    const warnings: string[] = [];
    let blocked: string | undefined;

    // A node name from the lost cluster names a machine the destination does
    // not have. Left in place it becomes a nodeSelector nothing satisfies, and
    // the pod waits forever instead of failing.
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

    // Asked of the same code that will do it, so the plan cannot promise data
    // the rebuild then does not restore.
    //
    // Both halves are reported. A plan that listed only the gaps left silence
    // meaning two different things — "this comes back" and "this application
    // has no data at all" — and the reader could not tell which, on the one
    // screen where that is the whole question.
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
      phase: this.phaseOf(app),
    };
  }

  /**
   * Summed for the whole set, never app by app.
   *
   * Checking one at a time answers a different question: each may fit while
   * the set does not, and the rebuild discovers it halfway through, with some
   * applications moved and some not.
   */
  private async planCapacity(
    to: ClusterEntity,
    apps: ApplicationEntity[],
  ): Promise<RebuildPlan['capacity']> {
    if (!to.kubeconfigEncrypted) {
      throw new Error('the destination has no kubeconfig');
    }
    const kubeconfig = this.encryption.decrypt(to.kubeconfigEncrypted);
    // Both already in the units this reports — `getNodeAllocatable` returns
    // millicores and MiB, not cores and bytes. Converting them again read a
    // 2-core node as 2000000m and a 3.7Gi one as 0Mi, which refused every
    // rebuild for want of memory the destination had.
    const allocatable = await this.k8s.getNodeAllocatable(kubeconfig);
    // Minus what is already asked for: allocatable alone is the size of the
    // cluster, not the room in it, and a destination that is merely large
    // would pass while having nowhere to put anything.
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
   * Does the source still answer, and how sure are we?
   *
   * Deliberately a call that throws. `listResourcesByLabel` answers `[]` for an
   * unreachable cluster as readily as for an empty one, and reading that as
   * "lost" would let a rebuild run against a cluster that is merely busy.
   *
   * Bounded, because the case this exists for is the case where it hangs: a
   * powered-off host does not refuse the connection, it swallows the packets,
   * and the kernel takes over two minutes to give up. Unbounded, the plan
   * became unanswerable exactly when somebody needed it — measured against a
   * cluster stopped at the provider, not reasoned about.
   *
   * The two negative answers are not the same and are not merged. A refused or
   * failed connection is proof the cluster is not serving. A silence that
   * outlasts the deadline is not: a control plane partitioned from a workload
   * cluster sees precisely this while the applications there keep running and
   * keep writing. The caller is told which one it got.
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

  /**
   * Records what is already true rather than deciding anything.
   *
   * `DELETED` would claim a decision nobody made, and `READY` keeps the cluster
   * in every deploy picker; `LOST` is the state a machine that stopped
   * answering was actually in.
   */
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
