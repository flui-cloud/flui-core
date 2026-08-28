import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../clusters/entities/cluster.entity';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ScalingDecisionEntity } from '../entities/scaling-decision.entity';
import {
  ScalingAssessment,
  ScalingEngineService,
} from './scaling-engine.service';
import { Actuation, ScalingActuatorService } from './scaling-actuator.service';

/**
 * How long the same answer stays the same answer.
 *
 * A decision is a resource somebody reads, not a log line: repeating "still
 * nothing to do" every tick would bury the row that says something. The row is
 * rewritten when the answer changes, and once an hour otherwise so a reader can
 * see the loop is alive.
 */
const REPEAT_SECONDS = 3600;

/**
 * One pass over every scaling group: it decides, it writes down what it decided,
 * and — where a group was set to act rather than to decide — it acts.
 *
 * The two halves stay separate all the way down. The engine cannot spend: it
 * produces words and, at most, an intent. Only the actuator can act on one, and
 * only through gates an API call cannot widen. On the providers where Flui
 * cannot create a server nothing changes at all: deciding without acting *is*
 * the alarm there, and the alarm names the shape and the price where a
 * catalogue publishes them and what a machine has to hold where none does.
 */
@Injectable()
export class ScalingReconcilerService {
  private readonly logger = new Logger(ScalingReconcilerService.name);

  constructor(
    @InjectRepository(ScalingGroupEntity)
    private readonly groups: Repository<ScalingGroupEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ScalingDecisionEntity)
    private readonly decisions: Repository<ScalingDecisionEntity>,
    private readonly engine: ScalingEngineService,
    private readonly actuator: ScalingActuatorService,
  ) {}

  async reconcileAll(): Promise<number> {
    const groups = await this.groups.find({ order: { createdAt: 'ASC' } });
    if (!groups.length) return 0;

    const clusters = await this.clusters.find({
      where: {
        id: In([...new Set(groups.map((group) => group.clusterId))]),
        // A cluster on its way out is skipped as firmly as one already gone.
        // Its groups are swept as part of the teardown, and a pass that read
        // them a moment earlier would write a decision about a group that no
        // longer exists — an orphan created by the very tick that should have
        // stood down.
        status: Not(In([ClusterStatus.DELETED, ClusterStatus.DELETING])),
      },
    });
    const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));

    let written = 0;
    for (const group of groups) {
      const cluster = byId.get(group.clusterId);
      // A group whose cluster is gone or being deleted decides nothing: there
      // is no fleet to size and no pod that could be waiting on one.
      if (!cluster) continue;
      try {
        if (await this.reconcile(group, cluster)) written += 1;
      } catch (err) {
        this.logger.error(
          `Scaling group ${group.id} could not be assessed: ${(err as Error).message}`,
        );
      }
    }
    return written;
  }

  async reconcile(
    group: ScalingGroupEntity,
    cluster: ClusterEntity,
  ): Promise<boolean> {
    const assessment = await this.engine.assess(group, cluster);
    const acted = await this.actuator.act(group, cluster, assessment);

    // Something happened to a machine, and that is never a repeat of anything:
    // the window below exists to stop a standing answer from being restated,
    // not to swallow the row that says money was spent.
    if (!acted?.operationId && (await this.alreadySaid(assessment, acted))) {
      return false;
    }

    await this.decisions.save(this.decisions.create(rowOf(assessment, acted)));
    return true;
  }

  private async alreadySaid(
    assessment: ScalingAssessment,
    acted: Actuation | null,
  ): Promise<boolean> {
    const last = await this.decisions.findOne({
      where: { groupId: assessment.groupId },
      order: { at: 'DESC' },
    });
    if (!last) return false;
    if (Date.now() - last.at.getTime() >= REPEAT_SECONDS * 1000) return false;
    return (
      last.force === assessment.force &&
      last.outcome === (acted?.outcome ?? assessment.outcome) &&
      last.why === (acted?.why ?? assessment.why) &&
      (last.shape ?? null) === assessment.shape &&
      (last.region ?? null) === assessment.region
    );
  }
}

function rowOf(
  assessment: ScalingAssessment,
  acted: Actuation | null,
): Partial<ScalingDecisionEntity> {
  return {
    groupId: assessment.groupId,
    clusterId: assessment.clusterId,
    at: new Date(),
    force: assessment.force,
    outcome: acted?.outcome ?? assessment.outcome,
    saw: assessment.saw,
    did: acted?.did ?? assessment.did,
    why: acted?.why ?? assessment.why,
    asks: acted ? acted.asks : assessment.asks,
    shape: assessment.shape,
    region: assessment.region,
    hourlyPriceEur: assessment.hourlyEur,
    considered: assessment.considered,
    pendingPods: assessment.pendingPods,
    drain: assessment.drain,
  };
}
