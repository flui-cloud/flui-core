import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  isControlClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  K3sClusterUpgradeState,
  K3sUpgradeOperationMetadata,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { RELEASE } from '../../../config/release.config';
import { ReleaseManifestService } from './release-manifest.service';
import {
  K3S_STEP_BASE_MS,
  K3S_STEP_PER_NODE_MS,
  k3sPlans,
} from '../utils/k3s-plans.util';
import {
  K3sClusterPort,
  K3sJobView,
  K3sNodeView,
  K3sUpgradePlan,
} from '../interfaces/k3s-upgrade.interface';
import { kubernetesK3sClusterPort } from '../utils/k3s-cluster-port.util';
import {
  K3sClusterReading,
  allNodesAt,
  assessK3sCluster,
  initialK3sState,
  nodeStates,
} from '../utils/k3s-upgrade-state.util';

const POLL_MS = 10_000;
/** A one-server cluster is unreachable while K3s restarts; minutes, not seconds, is the alarm. */
const UNREACHABLE_LIMIT_MS = 10 * 60_000;

const nowIso = (ms: number) => new Date(ms).toISOString();

interface K3sStepContext {
  operationId: string;
  cluster: ClusterEntity;
  port: K3sClusterPort;
  step: string;
}

type K3sStepProgress =
  | { finished: K3sClusterUpgradeState }
  | { state: K3sClusterUpgradeState; plansWritten: boolean };

function nodeFailureMessage(
  failed: { name: string; message?: string },
  step: string,
): string {
  const reason = failed.message ? `: ${failed.message}` : '';
  return `The K3s upgrade of node ${failed.name} to ${step} failed${reason}. Nothing was rolled back; the node may still be cordoned.`;
}

/**
 * Upgrading K3s through the system-upgrade-controller, one minor version at a
 * time.
 *
 * Each step writes the two Plans at that version and waits until every node's
 * kubelet reports it; only then is the next step started and the cluster's
 * recorded version moved. The state of every node lives in the operation, so a
 * run that stops anywhere — including the API itself restarting with the
 * control's server — continues from where it was, and a run over nodes that
 * already report the target does nothing.
 */
@Injectable()
export class K3sUpgradeService {
  private readonly logger = new Logger(K3sUpgradeService.name);
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    private readonly encryptionService: EncryptionService,
    private readonly kubernetesService: KubernetesService,
    private readonly releases: ReleaseManifestService,
  ) {}

  /**
   * What upgrading would do, per cluster, and what stops it. Without an id,
   * every ready cluster: workload clusters first, the control last — the order
   * an upgrade takes them in.
   */
  async plan(
    clusterId?: string,
    targetVersion: string = RELEASE.k3s.version,
  ): Promise<K3sUpgradePlan[]> {
    const clusters = clusterId
      ? [await this.cluster(clusterId)]
      : (
          await this.clusterRepository.find({
            where: { status: ClusterStatus.READY },
          })
        )
          .filter((c) => c.kubeconfigEncrypted)
          .sort(
            (a, b) =>
              Number(isControlClusterType(a.clusterType)) -
              Number(isControlClusterType(b.clusterType)),
          );
    const out: K3sUpgradePlan[] = [];
    for (const cluster of clusters) {
      out.push(await this.planFor(cluster, targetVersion));
    }
    return out;
  }

  private async planFor(
    cluster: ClusterEntity,
    targetVersion: string,
  ): Promise<K3sUpgradePlan> {
    const base = {
      clusterId: cluster.id,
      clusterName: cluster.name,
      clusterType: isControlClusterType(cluster.clusterType)
        ? ('control' as const)
        : ('workload' as const),
      recordedVersion: cluster.k3sVersion ?? null,
      targetVersion,
    };
    const reading: K3sClusterReading = {
      nodes: [],
      controller: { installed: false, ready: false },
    };
    try {
      const port = this.clusterPort(this.kubeconfigOf(cluster));
      reading.nodes = await port.nodes();
      reading.controller = await port.controller();
    } catch (error) {
      reading.readError = (error as Error).message;
    }
    return {
      ...base,
      ...assessK3sCluster(
        reading,
        targetVersion,
        await this.publishedReleases(),
      ),
    };
  }

  /**
   * Brings one cluster to the target, resuming whatever the operation already
   * recorded for it. Throws once the cluster's state is recorded as failed.
   */
  async run(
    operationId: string,
    clusterId: string,
    targetVersion: string = RELEASE.k3s.version,
  ): Promise<K3sClusterUpgradeState> {
    const cluster = await this.cluster(clusterId);
    const port = this.clusterPort(this.kubeconfigOf(cluster));
    let state = await this.recordedState(operationId, clusterId);

    if (state && state.targetVersion !== targetVersion) {
      if (state.status === 'running') {
        throw new ConflictException(
          `This operation is upgrading ${cluster.name} to ${state.targetVersion}, not ${targetVersion}.`,
        );
      }
      state = null;
    }
    if (state?.status === 'done') return state;

    if (!state) {
      const plan = await this.planFor(cluster, targetVersion);
      state = initialK3sState(
        plan,
        clusterId,
        targetVersion,
        nowIso(this.now()),
      );
      if (plan.upToDate) {
        state.status = 'done';
        await this.save(operationId, state);
        return state;
      }
      if (plan.blockers.length > 0) {
        return this.fail(operationId, state, plan.blockers.join(' '));
      }
      await this.save(operationId, state);
    } else if (state.status === 'failed') {
      state = { ...state, status: 'running', error: undefined };
      await this.save(operationId, state);
    }

    await this.markStep(operationId);
    while (state.stepIndex < state.steps.length) {
      state = await this.runStep(operationId, cluster, port, state);
    }
    await this.removePlans(port);
    state = { ...state, status: 'done', updatedAt: nowIso(this.now()) };
    await this.save(operationId, state);
    this.logger.log(`K3s on ${cluster.name} is at ${targetVersion}`);
    return state;
  }

  private async runStep(
    operationId: string,
    cluster: ClusterEntity,
    port: K3sClusterPort,
    initial: K3sClusterUpgradeState,
  ): Promise<K3sClusterUpgradeState> {
    const step = initial.steps[initial.stepIndex];
    const ctx: K3sStepContext = { operationId, cluster, port, step };
    let state: K3sClusterUpgradeState = {
      ...initial,
      stepStartedAt: initial.stepStartedAt ?? nowIso(this.now()),
    };
    const budget =
      K3S_STEP_BASE_MS + K3S_STEP_PER_NODE_MS * Math.max(1, state.nodes.length);
    let plansWritten = false;
    let saved = JSON.stringify(initial);

    for (;;) {
      if (!(await this.stillInProgress(operationId))) {
        await this.removePlans(port);
        throw new ConflictException(
          `The operation is no longer in progress; the K3s upgrade to ${step} on ${cluster.name} stops here.`,
        );
      }
      const tick = await this.observe(port);
      const progress = tick
        ? await this.onTick(ctx, state, tick, plansWritten)
        : await this.onUnreachable(ctx, state, plansWritten);
      if ('finished' in progress) return progress.finished;
      ({ state, plansWritten } = progress);

      if (this.now() - Date.parse(state.stepStartedAt as string) > budget) {
        return this.fail(
          operationId,
          state,
          `The K3s upgrade to ${step} did not finish within ${Math.round(budget / 60_000)} minutes.`,
          port,
        );
      }
      const snapshot = JSON.stringify({ ...state, updatedAt: undefined });
      if (snapshot !== saved) {
        saved = snapshot;
        state = { ...state, updatedAt: nowIso(this.now()) };
        await this.save(operationId, state);
      }
      await this.sleep(POLL_MS);
    }
  }

  private async onTick(
    ctx: K3sStepContext,
    current: K3sClusterUpgradeState,
    tick: { nodes: K3sNodeView[]; jobs: K3sJobView[] },
    plansWritten: boolean,
  ): Promise<K3sStepProgress> {
    const { operationId, cluster, port, step } = ctx;
    let state: K3sClusterUpgradeState = { ...current, unreachableSince: null };
    state.nodes = nodeStates(state.nodes, tick, step);
    const failed = state.nodes.find((n) => n.status === 'failed');
    if (failed) {
      return this.fail(
        operationId,
        state,
        nodeFailureMessage(failed, step),
        port,
      );
    }
    if (allNodesAt(tick.nodes, step)) {
      await this.clusterRepository.update(cluster.id, {
        k3sVersion: step,
      });
      state = {
        ...state,
        stepIndex: state.stepIndex + 1,
        stepStartedAt: undefined,
        updatedAt: nowIso(this.now()),
      };
      await this.save(operationId, state);
      this.logger.log(`K3s step ${step} done on ${cluster.name}`);
      return { finished: state };
    }
    if (plansWritten) return { state, plansWritten };
    const written = await this.writePlans(port, step);
    if (written === 'not-installed') {
      return this.fail(
        operationId,
        state,
        'The system-upgrade-controller is not installed on this cluster. Refresh its manifests first.',
        port,
      );
    }
    return { state, plansWritten: written === 'written' };
  }

  private async onUnreachable(
    ctx: K3sStepContext,
    current: K3sClusterUpgradeState,
    plansWritten: boolean,
  ): Promise<K3sStepProgress> {
    const since = current.unreachableSince ?? nowIso(this.now());
    const state = { ...current, unreachableSince: since };
    if (this.now() - Date.parse(since) > UNREACHABLE_LIMIT_MS) {
      return this.fail(
        ctx.operationId,
        state,
        `The cluster's API has not answered for ${UNREACHABLE_LIMIT_MS / 60_000} minutes during the K3s upgrade to ${ctx.step}.`,
        ctx.port,
      );
    }
    return { state, plansWritten };
  }

  private async observe(
    port: K3sClusterPort,
  ): Promise<{ nodes: K3sNodeView[]; jobs: K3sJobView[] } | null> {
    try {
      const nodes = await port.nodes();
      const jobs = await port.jobs();
      return nodes.length > 0 ? { nodes, jobs } : null;
    } catch {
      return null;
    }
  }

  private async writePlans(
    port: K3sClusterPort,
    step: string,
  ): Promise<'written' | 'not-installed' | 'retry'> {
    try {
      const controller = await port.controller();
      if (!controller.installed) return 'not-installed';
      await port.applyPlans(k3sPlans(step));
      return 'written';
    } catch (error) {
      this.logger.warn(
        `Could not write the K3s plans yet: ${(error as Error).message}`,
      );
      return 'retry';
    }
  }

  private async publishedReleases() {
    return this.releases
      .getManifest()
      .then((m) => m.manifest.releases)
      .catch(() => []);
  }

  private async cluster(clusterId: string): Promise<ClusterEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster)
      throw new NotFoundException(`Cluster ${clusterId} not found.`);
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster ${cluster.name} has no kubeconfig recorded.`,
      );
    }
    return cluster;
  }

  private kubeconfigOf(cluster: ClusterEntity): string {
    return this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted as string,
    );
  }

  private async recordedState(
    operationId: string,
    clusterId: string,
  ): Promise<K3sClusterUpgradeState | null> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });
    if (!operation) {
      throw new NotFoundException(`Operation ${operationId} not found.`);
    }
    const metadata = (operation.metadata ?? {}) as K3sUpgradeOperationMetadata;
    return metadata.k3sUpgrades?.[clusterId] ?? null;
  }

  /** Re-read before writing: other phases of the same operation write its metadata too. */
  private async save(
    operationId: string,
    state: K3sClusterUpgradeState,
  ): Promise<void> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });
    if (!operation) return;
    const metadata = (operation.metadata ?? {}) as K3sUpgradeOperationMetadata;
    const next: K3sUpgradeOperationMetadata = {
      ...metadata,
      k3sUpgrades: {
        ...metadata.k3sUpgrades,
        [state.clusterId]: state,
      },
    };
    operation.metadata = next;
    await this.operationRepository.save(operation);
  }

  /**
   * A Plan left behind keeps selecting nodes: one that joins later with
   * another version would be cordoned and upgraded by nobody's request.
   */
  private async removePlans(port: K3sClusterPort): Promise<void> {
    try {
      await port.deletePlans();
    } catch (error) {
      this.logger.warn(
        `Could not remove the K3s upgrade Plans: ${(error as Error).message}`,
      );
    }
  }

  private async stillInProgress(operationId: string): Promise<boolean> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });
    return (
      !!operation &&
      operation.status !== OperationStatus.FAILED &&
      operation.status !== OperationStatus.CANCELLED &&
      operation.status !== OperationStatus.COMPLETED
    );
  }

  private async markStep(operationId: string): Promise<void> {
    await this.operationRepository.update(operationId, {
      currentStep: OperationStep.PLATFORM_UPDATE_K3S,
    });
  }

  private async fail(
    operationId: string,
    state: K3sClusterUpgradeState,
    error: string,
    port?: K3sClusterPort,
  ): Promise<never> {
    if (port) await this.removePlans(port);
    await this.save(operationId, {
      ...state,
      status: 'failed',
      error,
      updatedAt: nowIso(this.now()),
    });
    throw new ConflictException(error);
  }

  /** The cluster API the upgrade uses; replaced in tests. */
  clusterPort(kubeconfig: string): K3sClusterPort {
    return kubernetesK3sClusterPort(this.kubernetesService, kubeconfig);
  }
}
