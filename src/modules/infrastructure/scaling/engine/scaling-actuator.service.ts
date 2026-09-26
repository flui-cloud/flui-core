import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';
import { ClusterScalingService } from '../../clusters/services/cluster-scaling.service';
import {
  ClusterBounds,
  ClusterBoundsRegistry,
} from '../../clusters/services/cluster-bounds.registry';
import { AutoscaleReconcilerRegistry } from '../../clusters/services/autoscale-reconciler.registry';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ScalingGroupService } from '../services/scaling-group.service';
import { ScalingAssessment } from './scaling-engine.service';
import { ActuationFacts, ActuationVerdict, mayAct } from './actuation.core';
import { purchaseHold } from './purchase-hold';

/** What acting changed about the decision that was going to be written. */
export interface Actuation {
  outcome: ScalingAssessment['outcome'];
  did: string;
  why: string;
  /**
   * What a person still has to do. Null once nothing is left for one, which is
   * every acted decision — and not null when acting was *tried* and refused,
   * because that is precisely when somebody is needed and nothing else says so.
   */
  asks: string | null;
  /** The operation that is now under way, where one is. */
  operationId: string | null;
}

const IN_FLIGHT = [OperationStatus.PENDING, OperationStatus.IN_PROGRESS];

/**
 * The one thing in this feature with hands.
 *
 * Everything upstream decides and writes down; this reads a decision that
 * would do something and either does it or says, in the decision itself, which
 * gate stopped it. Keeping that in one file is the point: there is exactly one
 * place to read to know what an installation can do to itself while nobody is
 * watching, and exactly one place a review has to be sure about.
 */
@Injectable()
export class ScalingActuatorService implements OnModuleInit {
  private readonly logger = new Logger(ScalingActuatorService.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ScalingGroupEntity)
    private readonly groups: Repository<ScalingGroupEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRows: Repository<ClusterEntity>,
    private readonly clusters: ClusterScalingService,
    private readonly groupService: ScalingGroupService,
    private readonly reconcilers: AutoscaleReconcilerRegistry,
    private readonly bounds: ClusterBoundsRegistry,
  ) {}

  /**
   * Registering here, and only here, is what flips what a cluster says about
   * itself. Nothing upstream registers: a loop that decides and does not act
   * must never make the capacity gate promise a node.
   */
  onModuleInit(): void {
    this.reconcilers.register('scaling-groups', {
      name: 'scaling-groups',
      drives: (clusterId) => this.drivesCluster(clusterId),
    });

    // Once a cluster has a group, its bounds are the group's. Registering them
    // here is what keeps a ceiling raised on the group from being enforced at
    // the old number by the node fence.
    this.bounds.register({
      name: 'scaling-groups',
      boundsFor: (clusterId) => this.boundsFor(clusterId),
      writeBounds: (clusterId, bounds) => this.writeBounds(clusterId, bounds),
    });
  }

  /**
   * The bounds of this cluster's group, or nothing where it has none. Several
   * groups on one cluster are a case the dashboard does not create; the widest
   * pair wins, so the fence never sits tighter than any one group's own ceiling.
   */
  async boundsFor(clusterId: string): Promise<ClusterBounds | null> {
    const groups = await this.groups.find({ where: { clusterId } });
    if (groups.length === 0) return null;
    return {
      min: Math.min(...groups.map((g) => g.minNodes)),
      max: Math.max(...groups.map((g) => g.maxNodes)),
    };
  }

  /**
   * Moves a floor and ceiling set through the older cluster route onto the
   * group that actually enforces them. The target follows the floor and the
   * ceiling rather than being left outside them.
   */
  async writeBounds(
    clusterId: string,
    bounds: ClusterBounds,
  ): Promise<boolean> {
    const groups = await this.groups.find({ where: { clusterId } });
    if (groups.length !== 1) return false;

    const group = groups[0];
    if (bounds.min != null) group.minNodes = bounds.min;
    if (bounds.max != null) group.maxNodes = bounds.max;
    group.desiredNodes = Math.min(
      Math.max(group.desiredNodes, group.minNodes),
      group.maxNodes,
    );
    await this.groups.save(group);
    return true;
  }

  /**
   * Whether a node would actually arrive on this cluster without being asked.
   *
   * What the capacity gate and `autoscale/status` say about a cluster is derived
   * from this, so the promise can never outlive the thing that keeps it: set
   * every group back to manual and both surfaces stop claiming a node appears
   * on its own — with no sentence to go and edit.
   */
  async drivesCluster(clusterId: string): Promise<boolean> {
    const automatic = await this.groups.count({
      where: { clusterId, provision: 'automatic' },
    });
    if (!automatic) return false;
    const cluster = await this.clusterRows.findOne({
      where: { id: clusterId },
    });
    return Boolean(
      cluster && this.groupService.capabilityOf(cluster.provider).canProvision,
    );
  }

  /**
   * Null leaves the decision exactly as the engine wrote it — which is the
   * answer wherever the provider cannot be bought from, because there the
   * engine's own words are already the complete truth.
   */
  async act(
    group: ScalingGroupEntity,
    cluster: ClusterEntity,
    assessment: ScalingAssessment,
  ): Promise<Actuation | null> {
    const intent = assessment.intent;
    if (!intent) return this.onItsWay(cluster, assessment);

    const capability = this.groupService.capabilityOf(cluster.provider);
    const verdict = mayAct({
      canProvision: capability.canProvision,
      provision: group.provision,
      clusterReady: cluster.status === ClusterStatus.READY,
      monthlyCap: group.maxMonthlyCost,
      purchaseInFlight: await this.inFlight(cluster.id),
      failedPurchase: await this.failedPurchase(
        cluster.id,
        group.purchaseRetryAt,
      ),
      ...(await this.lastJoin(cluster.id)),
      clusterRegion: cluster.region ?? null,
      reachableRegions: await this.groupService.buyableFor(cluster),
      intent,
    });

    if (!verdict.act) return this.refused(verdict, assessment);

    try {
      if (intent.kind !== 'remove') {
        return await this.buy(
          cluster,
          intent.shape,
          intent.region,
          verdict,
          assessment,
        );
      }
      // Nothing is removed unnamed: an intent that lost its node between the
      // reading and here removes nothing rather than the next best thing.
      if (!intent.node) return null;
      return await this.remove(
        cluster,
        intent.node,
        verdict,
        assessment,
        Boolean(intent.completesReplacement),
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `Scaling group ${group.id} could not act on ${cluster.id}: ${message}`,
      );
      // A refusal from the provider path is a fact about this cluster, not a
      // hiccup to retry quietly: it is the same shape of answer as a decline,
      // and it belongs where somebody already looks for why nothing happened.
      return {
        outcome: 'alerted',
        did: 'Tried and failed.',
        why: `${assessment.did} It was refused: ${message}`,
        asks: `This group was allowed to act and could not: ${message} Nothing will change here until that is cleared.`,
        operationId: null,
      };
    }
  }

  /**
   * An urgent alarm raised while a machine is already being added is almost
   * always about that machine: the ladder counts it into the fleet's spend and
   * finds nothing more it may buy. Nobody needs calling for that — the work is
   * waiting for the node on its way, and if it still has nowhere to run once
   * the node has joined, the next pass raises the alarm again.
   */
  private async onItsWay(
    cluster: ClusterEntity,
    assessment: ScalingAssessment,
  ): Promise<Actuation | null> {
    if (assessment.outcome !== 'alerted' || assessment.force !== 'urgency') {
      return null;
    }
    if (!(await this.inFlight(cluster.id))) return null;
    return {
      outcome: 'declined',
      did: 'Nothing more — a machine is already on its way.',
      why: 'The waiting work is expected to land on the node being added. If it still has nowhere to run once that node has joined, the alarm is raised then.',
      asks: null,
      operationId: null,
    };
  }

  private refused(
    verdict: ActuationVerdict,
    assessment: ScalingAssessment,
  ): Actuation | null {
    // The provider that cannot be bought from is already the whole of what the
    // engine said; repeating it would put the same sentence twice on one row.
    if (verdict.refusal === 'provider-cannot-buy') return null;

    // Urgency held back only by consent is a question, not a decline: the
    // machine and its price are already chosen and something is waiting on the
    // answer. Only `alerted` carries an ask, so this is the outcome that
    // reaches a person rather than sitting in the log.
    if (verdict.refusal === 'last-purchase-failed') {
      return {
        outcome: 'alerted',
        did: 'Bought nothing.',
        why: verdict.because,
        asks: verdict.because,
        operationId: null,
      };
    }

    if (
      verdict.refusal === 'group-is-manual' &&
      assessment.force === 'urgency'
    ) {
      return {
        outcome: 'alerted',
        did: assessment.did,
        why: verdict.because,
        asks:
          assessment.asks ??
          `${assessment.did} Approve this one purchase (Buy on the Now tab, \`flui scaling approve --yes\`), add the machine yourself, or set this group to buy automatically.`,
        operationId: null,
      };
    }

    return {
      outcome: assessment.outcome,
      did: assessment.did,
      why: verdict.because,
      asks: assessment.asks,
      operationId: null,
    };
  }

  private async buy(
    cluster: ClusterEntity,
    shape: string | null,
    chosenRegion: string | null,
    verdict: ActuationVerdict,
    assessment: ScalingAssessment,
  ): Promise<Actuation> {
    const region = chosenRegion ?? cluster.region;
    const operation = await this.clusters.addWorkers(
      cluster.id,
      1,
      shape,
      region,
    );
    this.logger.log(
      `Scaling bought a ${shape ?? 'default'} for cluster ${cluster.id} (operation ${operation.id})`,
    );
    return {
      outcome: 'added',
      did: `Ordered a ${shape ?? cluster.nodeSize} in ${region}; it joins once provisioned.`,
      why: `${assessment.did} ${verdict.because}`,
      asks: null,
      operationId: operation.id,
    };
  }

  private async remove(
    cluster: ClusterEntity,
    nodeId: string,
    verdict: ActuationVerdict,
    assessment: ScalingAssessment,
    completesReplacement: boolean,
  ): Promise<Actuation> {
    const operation = await this.clusters.removeWorker(cluster.id, nodeId);
    this.logger.log(
      `Scaling removed node ${nodeId} from cluster ${cluster.id} (operation ${operation.id})`,
    );
    return {
      // `replaced` and `removed` leave the same fleet behind and are not the
      // same event: one finished what a standing order asked for, the other
      // undid an overshoot. Told apart here or not at all.
      outcome: completesReplacement ? 'replaced' : 'removed',
      did: assessment.did.replace(/^Would remove/, 'Removed'),
      why: verdict.because,
      asks: null,
      operationId: operation.id,
    };
  }

  private async failedPurchase(
    clusterId: string,
    retryAskedAt: Date | null | undefined,
  ): Promise<ActuationFacts['failedPurchase']> {
    const hold = await purchaseHold(this.operations, clusterId, retryAskedAt);
    if (!hold) return null;
    return { at: hold.failedAt, error: hold.error, until: hold.until };
  }

  private async lastJoin(
    clusterId: string,
  ): Promise<Pick<ActuationFacts, 'minutesSinceAdded' | 'lastJoinedAt'>> {
    const last = await this.operations.findOne({
      where: {
        resourceId: clusterId,
        operationType: OperationType.ADD_WORKER,
        status: OperationStatus.COMPLETED,
      },
      order: { completedAt: 'DESC' },
    });
    const at = last?.completedAt ?? last?.updatedAt;
    if (!at) return { minutesSinceAdded: null, lastJoinedAt: null };
    const joined = new Date(at);
    return {
      minutesSinceAdded: Math.floor((Date.now() - joined.getTime()) / 60_000),
      lastJoinedAt: joined,
    };
  }

  /**
   * A machine on its way is the whole reason a loop needs a memory.
   *
   * A pod stays unplaceable for every minute a node takes to provision, so a
   * pass that only looked at the fleet would buy another one on each tick and
   * still be buying when the first arrived.
   */
  private async inFlight(clusterId: string): Promise<boolean> {
    const count = await this.operations.count({
      where: {
        resourceId: clusterId,
        operationType: In([
          OperationType.ADD_WORKER,
          OperationType.REMOVE_WORKER,
        ]),
        status: In(IN_FLIGHT),
      },
    });
    return count > 0;
  }
}
