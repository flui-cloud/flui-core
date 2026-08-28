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
import { AutoscaleReconcilerRegistry } from '../../clusters/services/autoscale-reconciler.registry';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ScalingGroupService } from '../services/scaling-group.service';
import { ScalingAssessment } from './scaling-engine.service';
import { ActuationVerdict, mayAct } from './actuation.core';

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
    if (!intent) return null;

    const capability = this.groupService.capabilityOf(cluster.provider);
    const verdict = mayAct({
      canProvision: capability.canProvision,
      provision: group.provision,
      clusterReady: cluster.status === ClusterStatus.READY,
      monthlyCap: group.maxMonthlyCost,
      purchaseInFlight: await this.inFlight(cluster.id),
      clusterRegion: cluster.region ?? null,
      intent,
    });

    if (!verdict.act) return this.refused(verdict, assessment);

    try {
      if (intent.kind !== 'remove') {
        return await this.buy(cluster, intent.shape, verdict, assessment);
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

  private refused(
    verdict: ActuationVerdict,
    assessment: ScalingAssessment,
  ): Actuation | null {
    // The provider that cannot be bought from is already the whole of what the
    // engine said; repeating it would put the same sentence twice on one row.
    if (verdict.refusal === 'provider-cannot-buy') return null;
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
    verdict: ActuationVerdict,
    assessment: ScalingAssessment,
  ): Promise<Actuation> {
    const operation = await this.clusters.addWorkers(cluster.id, 1, shape);
    this.logger.log(
      `Scaling bought a ${shape ?? 'default'} for cluster ${cluster.id} (operation ${operation.id})`,
    );
    return {
      outcome: 'added',
      did: `Bought a ${shape ?? cluster.nodeSize} in ${cluster.region} and set it to join.`,
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
