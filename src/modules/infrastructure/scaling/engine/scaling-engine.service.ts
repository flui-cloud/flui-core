import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { ClusterEntity } from '../../clusters/entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeStatus,
  NodeType,
} from '../../clusters/entities/cluster-node.entity';
import {
  UnschedulablePods,
  UnschedulablePodsService,
} from '../../clusters/services/unschedulable-pods.service';
import { AvailabilityCatalogueService } from '../catalogue/availability-catalogue.service';
import { unreadCatalogue } from '../catalogue/catalogue.core';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ProviderScalingCapability } from '../scaling-capability';
import {
  ConsideredCandidate,
  DecisionOutcome,
  ScalingForce,
  ScalingIntent,
  StandingOrderConfig,
} from '../scaling.core';
import { ScalingGroupService } from '../services/scaling-group.service';
import { ScalingPreviewDto } from '../dto/scaling-preview.dto';
import {
  FleetFacts,
  LadderInput,
  LadderResult,
  LadderRung,
  PendingDemand,
  ShapeFactsReading,
  budgetFloorNote,
  evaluateShape,
  fleetOf,
  monthlyFrom,
  reasonsOf,
  walkLadder,
} from './engine.core';
import { ShapeFactsService } from './shape-facts.service';
import { DrainCheck, drainSummary } from './drain.core';
import { DrainFeasibilityService } from './drain-feasibility.service';

/** What one pass over one group concluded, and would have written down. */
export interface ScalingAssessment {
  groupId: string;
  clusterId: string;
  force: ScalingForce;
  outcome: DecisionOutcome;
  saw: string;
  did: string;
  why: string;
  asks: string | null;
  shape: string | null;
  region: string | null;
  hourlyEur: number | null;
  considered: ConsideredCandidate[];
  /**
   * What this decision would do to the fleet, where it would do anything.
   *
   * Null on every decision that ends in words, which is all of them here:
   * nothing in this service can create, resize or remove a machine, and the
   * intent is what something else needs in order to.
   */
  intent: ScalingIntent | null;
  /** Whether the node a replacement would empty can actually be emptied. */
  drain: DrainCheck | null;
  /** Pods the scheduler could not place. Null is an unanswered cluster, never 0. */
  pendingPods: number | null;
  preview: ScalingPreviewDto;
}

/** Everything a decision carries but the identity of what it was decided about. */
type DecisionDraft = Omit<
  ScalingAssessment,
  'groupId' | 'clusterId' | 'preview' | 'pendingPods'
>;

/** A node the fleet could give back, named so something can actually remove it. */
interface RemovableNode {
  id: string;
  name: string;
  hourlyEur: number | null;
}

/**
 * The two forces on one fleet, decided and never acted on.
 *
 * Urgency runs on seconds and never waits: a pod cannot be placed, so a ladder
 * of fallbacks is walked and the first rung that would work wins. Opportunity
 * runs on hours and waiting *is* the mechanism: it grows toward the target when
 * the market allows, and nobody is held up if it never fires.
 *
 * They meet in one rule: urgency always wins, and the patient side stands down
 * entirely while anything is waiting — including while the cluster cannot be
 * asked whether anything is, because silence does not rule a pending pod out.
 *
 * Nothing here creates, resizes or removes a machine. Every outcome is a row
 * somebody can read, and the rows that decided nothing are the ones that answer
 * the only question an autoscaler is ever asked.
 */
@Injectable()
export class ScalingEngineService {
  constructor(
    @InjectRepository(ClusterNodeEntity)
    private readonly nodes: Repository<ClusterNodeEntity>,
    private readonly groups: ScalingGroupService,
    private readonly pending: UnschedulablePodsService,
    private readonly catalogue: AvailabilityCatalogueService,
    private readonly shapes: ShapeFactsService,
    private readonly drain: DrainFeasibilityService,
  ) {}

  async preview(groupId: string): Promise<ScalingPreviewDto> {
    const { group, cluster } = await this.groups.withCluster(groupId);
    return (await this.assess(group, cluster)).preview;
  }

  async assess(
    group: ScalingGroupEntity,
    cluster: ClusterEntity,
  ): Promise<ScalingAssessment> {
    const capability = this.groups.capabilityOf(cluster.provider);
    const waiting = await this.pending.read(cluster);
    const rows = await this.fleetRows(cluster);
    const fleet = fleetOf(rows, {
      nodes: cluster.nodeCount ?? 0,
      shape: cluster.nodeSize ?? null,
    });
    const input = await this.ladderInput(
      group,
      cluster,
      capability,
      fleet,
      demandOf(waiting),
      group.maxNodes,
    );

    const urgency = walkLadder(input);
    const held = heldBecause(waiting);
    const preview = toPreview(group.id, waiting, held, urgency);

    const decision = await this.decide(
      input,
      group,
      cluster,
      rows,
      waiting,
      urgency,
    );
    return {
      ...decision,
      groupId: group.id,
      clusterId: cluster.id,
      pendingPods: waiting ? waiting.count : null,
      preview,
    };
  }

  private async decide(
    input: LadderInput,
    group: ScalingGroupEntity,
    cluster: ClusterEntity,
    rows: ClusterNodeEntity[],
    waiting: UnschedulablePods | null,
    urgency: LadderResult,
  ): Promise<DecisionDraft> {
    if (!waiting) {
      // The floor is not a reading of the cluster: it is a fact about the
      // fleet's own rows, and it is the one bound held now, always. Standing it
      // down because a pod read failed leaves an installation below its floor
      // exactly when its cluster is in trouble — which is the moment the floor
      // exists for.
      if (input.fleet.nodes < group.minNodes) {
        return this.fromLadder(
          input,
          urgency,
          'urgency',
          `The cluster could not be asked what is waiting, and the fleet is at ${input.fleet.nodes} ${nodeWord(input.fleet.nodes)}, below the floor of ${group.minNodes}. The floor is held on the fleet's own count, which needs no answer from the cluster.`,
        );
      }

      return {
        force: 'urgency',
        outcome: 'declined',
        saw: 'The cluster could not be asked whether anything is waiting for capacity.',
        did: 'Nothing.',
        why: 'An unanswered cluster is not a quiet one. Until it answers, a pod may be waiting, so nothing was decided and the patient side stayed down. Its floor is met, and that much needed no answer.',
        asks: null,
        shape: null,
        region: null,
        hourlyEur: null,
        considered: [],
        intent: null,
        drain: null,
      };
    }

    if (waiting.count > 0) {
      const settling = withinSettleWindow(waiting, group.settleSeconds);
      if (settling) {
        return {
          force: 'urgency',
          outcome: 'declined',
          saw: sawPending(waiting),
          did: 'Nothing yet.',
          why: settling,
          asks: null,
          shape: null,
          region: null,
          hourlyEur: null,
          considered: [],
          intent: null,
          drain: null,
        };
      }
      return this.fromLadder(input, urgency, 'urgency', sawPending(waiting));
    }

    if (input.fleet.nodes < group.minNodes) {
      return this.fromLadder(
        input,
        urgency,
        'urgency',
        `The fleet is at ${input.fleet.nodes} ${nodeWord(input.fleet.nodes)}, below the floor of ${group.minNodes}.`,
      );
    }

    return this.opportunity(input, group, cluster, rows);
  }

  /**
   * The patient side, which runs only because nothing is waiting.
   *
   * It never raises an alarm where Flui could buy: nobody is held up by it, and
   * an alarm nobody needs is how an autoscaler teaches people to ignore it.
   */
  private async opportunity(
    input: LadderInput,
    group: ScalingGroupEntity,
    cluster: ClusterEntity,
    rows: ClusterNodeEntity[],
  ): Promise<DecisionDraft> {
    const fleet = input.fleet;
    const orders = openOrders(group, fleet.nodes, input);
    const saw = `Nothing is waiting. The fleet is at ${fleet.nodes} nodes against a target of ${group.desiredNodes}.`;

    // A fleet over its target is the same question whether a standing order put
    // the extra machine there or a burst did: one node too many, and the target
    // is the resting point it comes back to.
    if (fleet.nodes > group.desiredNodes && fleet.nodes > group.minNodes) {
      return this.giveBack(input, group, cluster, rows, orders, saw);
    }

    if (!orders.length) {
      return {
        force: 'opportunity',
        outcome: 'declined',
        saw,
        did: 'Nothing.',
        why:
          fleet.nodes >= group.desiredNodes
            ? 'The fleet is at its target and no standing order is open, so there is nothing for the patient side to do.'
            : 'No standing order is open, and being below the target buys nothing on its own — the target is approached when the market allows, never on the clock.',
        asks: null,
        shape: null,
        region: null,
        hourlyEur: null,
        considered: [],
        intent: null,
        drain: null,
      };
    }

    // The ceiling of the patient side is the target, not the maximum: only
    // urgency may reach past what the fleet would like to be.
    //
    // Except for a replacement, which cannot be done at the target at all: it
    // buys the stand-in, then drains and removes the node it stands in for, and
    // is therefore one above the target for as long as that takes. Held to the
    // target it can never take its first step — and the fleet waits for a
    // machine that is refused every minute, for ever, saying only that this
    // force may not go past a number.
    //
    // The hard ceiling still holds: a group with no headroom above its target
    // genuinely cannot replace by buying first, and that is worth saying rather
    // than looking like a market that has nothing.
    const patientCeiling = (order: StandingOrderConfig) =>
      order.kind === 'replace'
        ? Math.min(group.desiredNodes + 1, group.maxNodes)
        : group.desiredNodes;
    const rungs = orders.map((order) =>
      evaluateShape(
        { ...input, ceiling: patientCeiling(order) },
        order.shape,
        order.region,
      ),
    );
    const wonAt = rungs.findIndex((rung) => rung.outcome === 'would-buy');

    if (wonAt === -1) {
      const airless = orders.some(
        (order) =>
          order.kind === 'replace' && group.maxNodes <= group.desiredNodes,
      );
      return {
        force: 'opportunity',
        outcome: 'declined',
        saw,
        did: 'Waiting.',
        why: airless
          ? `A replacement buys the stand-in before it drains the node it stands in for, so it needs the fleet to sit one above its target of ${group.desiredNodes} for a while. This group's ceiling is ${group.maxNodes}, which leaves no room for that. Raise the ceiling, or replace the node by hand.`
          : `Nothing the standing orders wait for can be had yet. ${reasonsOf(rungs)}`.trim(),
        asks: null,
        shape: null,
        region: null,
        hourlyEur: null,
        considered: rungs.map(toConsidered),
        intent: null,
        drain: null,
        // Waiting is the mechanism here, so this is not an alarm.
      };
    }

    const order = orders[wonAt];
    const rung = rungs[wonAt];
    const losers = rungs
      .filter((_, index) => index !== wonAt)
      .map(toConsidered);

    if (order.kind === 'replace') {
      return this.replacement(input, cluster, rows, order, rung, saw, losers);
    }

    if (!input.group.capability.canProvision) {
      const asks = `${rung.shape} is available in ${rung.region}${priced(rung)}. Buy one and join it with \`flui node connect\` to reach the target of ${group.desiredNodes} nodes. Flui cannot create a server on ${input.group.provider}.`;
      return {
        force: 'opportunity',
        outcome: 'alerted',
        saw,
        did: 'Raised an alarm naming the machine to attach.',
        why: `The shape this group waits for is available, and buying it is the one step nothing here can take.`,
        asks,
        shape: rung.shape,
        region: rung.region,
        hourlyEur: rung.hourlyEur,
        considered: losers,
        intent: null,
        drain: null,
      };
    }

    return {
      force: 'opportunity',
      outcome: 'declined',
      saw,
      did: `Would add a ${rung.shape} in ${rung.region}${priced(rung)}.`,
      why: notActed(input),
      asks: null,
      shape: rung.shape,
      region: rung.region,
      hourlyEur: rung.hourlyEur,
      considered: losers,
      intent: addIntent(rung, input.fleet),
      drain: null,
    };
  }

  /**
   * A replacement, asked in the order that cannot strand a machine: the node has
   * to be emptiable **before** the stand-in is bought. The other order buys
   * first and discovers the refusal afterwards, and then the fleet is one node
   * over for good while the bill is the only thing that mentions it.
   */
  private async replacement(
    input: LadderInput,
    cluster: ClusterEntity,
    rows: ClusterNodeEntity[],
    order: StandingOrderConfig,
    rung: LadderRung,
    saw: string,
    losers: ConsideredCandidate[],
  ): Promise<DecisionDraft> {
    const target = rows.find(
      (row) => row.serverName === order.replaces || row.id === order.replaces,
    );
    if (!target) {
      return {
        force: 'opportunity',
        outcome: 'declined',
        saw,
        did: 'Nothing.',
        why: `This group waits to replace ${order.replaces}, and no node of this fleet goes by that name — most often because the replacement already happened and the order outlived it. Nothing is bought for a replacement whose other half does not exist: point the order at another node, or take it out.`,
        asks: null,
        shape: rung.shape,
        region: rung.region,
        hourlyEur: rung.hourlyEur,
        considered: losers,
        intent: null,
        drain: null,
      };
    }

    const drain = await this.drain.check(cluster, target);
    if (!drain) {
      return {
        force: 'opportunity',
        outcome: 'declined',
        saw,
        did: 'Nothing.',
        why: `The cluster could not be asked whether ${target.serverName} can be emptied, and an unanswered cluster is not an empty one. Nothing is bought until it answers.`,
        asks: null,
        shape: rung.shape,
        region: rung.region,
        hourlyEur: rung.hourlyEur,
        considered: losers,
        intent: null,
        drain: null,
      };
    }

    if (!drain.ok) {
      return {
        force: 'opportunity',
        outcome: 'declined',
        saw,
        did: 'Nothing.',
        why: `${target.serverName} cannot be emptied, so nothing is bought to replace it. ${drainSummary(drain)}`,
        asks: null,
        shape: rung.shape,
        region: rung.region,
        hourlyEur: rung.hourlyEur,
        considered: losers,
        intent: null,
        drain,
      };
    }

    return {
      force: 'opportunity',
      outcome: 'declined',
      saw,
      did: `Would buy a ${rung.shape} in ${rung.region}${priced(rung)} to replace ${target.serverName}, which can be emptied.`,
      why: notActed(input),
      asks: null,
      shape: rung.shape,
      region: rung.region,
      hourlyEur: rung.hourlyEur,
      considered: losers,
      intent: {
        kind: 'replace',
        shape: rung.shape,
        region: rung.region,
        hourlyEur: rung.hourlyEur,
        node: target.id,
        fleetMonthlyEur: input.fleet.committedMonthlyEur,
        unpricedNodes: input.fleet.unpricedNodes,
        fleetNodes: input.fleet.nodes,
      },
      drain,
    };
  }

  /**
   * The fleet is above its target with nothing waiting, so a machine goes back.
   *
   * Where a standing order named the node to replace, this is that order's
   * second half: the stand-in has arrived and the node it stood in for is the
   * one that goes. Where none did, the fleet simply overshot, and the most
   * expensive worker is what returning to the target is for.
   */
  private async giveBack(
    input: LadderInput,
    group: ScalingGroupEntity,
    cluster: ClusterEntity,
    rows: ClusterNodeEntity[],
    orders: StandingOrderConfig[],
    saw: string,
  ): Promise<DecisionDraft> {
    const words = (did: string, why: string, drain: DrainCheck | null = null) =>
      ({
        force: 'opportunity',
        outcome: 'declined',
        saw,
        did,
        why,
        asks: null,
        shape: null,
        region: null,
        hourlyEur: null,
        considered: [],
        intent: null,
        drain,
      }) as DecisionDraft;

    if (!rows.length) {
      return words(
        'Nothing.',
        `The fleet is above its target of ${group.desiredNodes}, and no node of it is recorded — nothing can be given back by name.`,
      );
    }

    const named = orders.find((order) => order.kind === 'replace')?.replaces;
    const candidate = pickRemovable(rows, named ?? null);
    if (!candidate) {
      return words(
        'Nothing.',
        'The fleet is above its target, and every node in it is either the master or already on its way out.',
      );
    }

    // Two floors, and they do not count the same thing. A group's `min` is a
    // bound on the fleet; the cluster's own `minNodes` is a bound on its
    // *workers*, and the master does not count toward it. A fleet of two that
    // clears the group's floor can still be one worker that does not clear the
    // cluster's — and finding that out from the provider path means writing
    // "tried and failed" where a decision could have said it plainly.
    const workers = rows.filter(
      (row) =>
        row.nodeType !== NodeType.MASTER && row.status !== NodeStatus.DELETING,
    ).length;
    if (cluster.minNodes != null && workers <= cluster.minNodes) {
      return words(
        'Nothing.',
        `The fleet is above its target of ${group.desiredNodes}, and giving a node back would leave ${workers - 1} worker(s) against this cluster's own floor of ${cluster.minNodes}. That floor counts workers, not the fleet, so the master does not make up the difference.`,
      );
    }

    const node = rows.find(
      (row) => row.id === candidate.id,
    ) as ClusterNodeEntity;
    const drain = await this.drain.check(cluster, node);
    if (!drain) {
      return words(
        'Nothing.',
        `The cluster could not be asked whether ${candidate.name} can be emptied. Nothing is removed on silence.`,
      );
    }

    if (!drain.ok) {
      // Loud rather than quiet, and named as the state it is: a fleet that
      // overshot and cannot come back is paid for every month, and the only
      // place that would otherwise say so is the invoice.
      return {
        force: 'opportunity',
        outcome: 'alerted',
        saw,
        did: 'Raised an alarm: the fleet is above its target and cannot come back on its own.',
        why: `${candidate.name} cannot be emptied. ${drainSummary(drain)}`,
        asks: `The fleet has ${input.fleet.nodes} nodes against a target of ${group.desiredNodes}, and ${candidate.name} is the one that would go back. It cannot be emptied as things stand, so it is being paid for until somebody clears what is in the way. ${drainSummary(drain)}`,
        shape: null,
        region: null,
        hourlyEur: candidate.hourlyEur,
        considered: [],
        intent: null,
        drain,
      };
    }

    return {
      force: 'opportunity',
      outcome: 'declined',
      saw,
      did: `Would remove ${candidate.name}, which can be emptied, bringing the fleet to ${input.fleet.nodes - 1} against a target of ${group.desiredNodes}.`,
      why: notActed(input),
      asks: null,
      shape: node.serverType ?? null,
      region: node.region ?? null,
      hourlyEur: candidate.hourlyEur,
      considered: [],
      intent: {
        kind: 'remove',
        shape: node.serverType ?? null,
        region: node.region ?? null,
        hourlyEur: candidate.hourlyEur,
        node: candidate.id,
        fleetMonthlyEur: input.fleet.committedMonthlyEur,
        unpricedNodes: input.fleet.unpricedNodes,
        fleetNodes: input.fleet.nodes,
        // A standing order named this node, so taking it out finishes a
        // replacement rather than trimming an overshoot.
        completesReplacement: Boolean(named) && candidate.name === named,
      },
      drain,
    };
  }

  private fromLadder(
    input: LadderInput,
    result: LadderResult,
    force: ScalingForce,
    saw: string,
  ): DecisionDraft {
    const considered = result.rungs
      .filter((rung) => rung !== result.chosen)
      .map(toConsidered);

    if (result.chosen) {
      return {
        force,
        outcome: 'declined',
        saw,
        did: `Would add a ${result.chosen.shape} in ${result.chosen.region}${priced(result.chosen)}.`,
        why: notActed(input),
        asks: null,
        shape: result.chosen.shape,
        region: result.chosen.region,
        hourlyEur: result.chosen.hourlyEur,
        considered,
        intent: addIntent(result.chosen, input.fleet),
        drain: null,
      };
    }

    const alarm = result.rungs[result.rungs.length - 1];
    return {
      force,
      outcome: 'alerted',
      saw,
      did: input.group.capability.canProvision
        ? 'Raised an alarm: no rung of the ladder could be taken.'
        : 'Raised an alarm, which is the whole of what this provider allows.',
      why: reasonsOf(result.rungs),
      asks: result.asks,
      shape: alarm.shape,
      region: alarm.region,
      hourlyEur: alarm.hourlyEur,
      considered,
      intent: null,
      drain: null,
    };
  }

  private async ladderInput(
    group: ScalingGroupEntity,
    cluster: ClusterEntity,
    capability: ProviderScalingCapability,
    fleet: FleetFacts,
    demand: PendingDemand | null,
    ceiling: number,
  ): Promise<LadderInput> {
    const shapes: ShapeFactsReading = capability.hasCatalogue
      ? await this.shapes.read(cluster.provider)
      : { shapes: [], read: false };
    const catalogue = capability.hasCatalogue
      ? await this.catalogue.read(cluster.provider)
      : unreadCatalogue(cluster.provider, 'no-market');

    return {
      group: {
        provider: cluster.provider,
        regions: group.regions ?? [],
        shapes: group.shapes ?? [],
        strategy: group.strategy,
        hourlyBillingOnly: group.hourlyBillingOnly,
        maxMonthlyCost: group.maxMonthlyCost,
        requirement: group.requirement ?? null,
        capability,
      },
      clusterRegion: cluster.region,
      ceiling,
      fleet,
      demand,
      shapes,
      catalogue,
    };
  }

  private fleetRows(cluster: ClusterEntity): Promise<ClusterNodeEntity[]> {
    return this.nodes.find({
      where: { clusterId: cluster.id, status: Not(NodeStatus.DELETING) },
    });
  }
}

const NOT_ACTED =
  'Nothing acts on a scaling decision here: the machine was not created, and it will not be until somebody adds one.';

/**
 * The winning rung cleared the ceiling, and on a partly priced fleet that is
 * the weaker of the two things the check can say — so the decision carries what
 * the figure was, rather than the reader taking silence for certainty.
 */
function notActed(input: LadderInput): string {
  const floor = budgetFloorNote(input);
  return floor ? `${NOT_ACTED} ${floor}` : NOT_ACTED;
}

const nodeWord = (count: number): string => (count === 1 ? 'node' : 'nodes');

function sawPending(waiting: UnschedulablePods): string {
  const largest = waiting.largestRequest;
  const oldest =
    waiting.oldestWaitingSeconds === null
      ? 'for an unknown time'
      : `for ${waiting.oldestWaitingSeconds}s`;
  const what = largest
    ? ` The largest asks for ${largest.cpuMillicores}m and ${largest.memoryMi}Mi (${largest.namespace}/${largest.name}).`
    : '';
  return `${waiting.count} pod(s) the scheduler could not place, waiting ${oldest}.${what}`;
}

/**
 * The one wait on the urgent path, and it is not patience: it never waits for a
 * cheaper shape, only to be sure the pod is genuinely stuck rather than caught
 * mid-schedule — another pod terminating, a drain finishing, the scheduler
 * halfway round.
 */
function withinSettleWindow(
  waiting: UnschedulablePods,
  settleSeconds: number,
): string | null {
  const oldest = waiting.oldestWaitingSeconds;
  // A pod that cannot be dated cannot be held: refusing to act on an unknown
  // age would turn a missing timestamp into an indefinite wait.
  if (oldest === null) return null;
  if (oldest >= settleSeconds) return null;
  return `The oldest has been stuck ${oldest}s of the ${settleSeconds}s this group waits before buying. That wait is not patience — it is there so a pod caught mid-schedule does not buy a machine.`;
}

function heldBecause(waiting: UnschedulablePods | null): string | null {
  if (!waiting) {
    return 'The cluster could not be asked whether anything is waiting, so urgency cannot be ruled out and no standing order runs.';
  }
  if (waiting.count > 0) {
    return `${waiting.count} pod(s) cannot be placed. Urgency always wins, and no standing order runs while one is waiting.`;
  }
  return null;
}

function demandOf(waiting: UnschedulablePods | null): PendingDemand | null {
  const largest = waiting?.largestRequest;
  if (!largest) return null;
  return {
    name: `${largest.namespace}/${largest.name}`,
    cpuMillicores: largest.cpuMillicores,
    memoryMi: largest.memoryMi,
  };
}

function toPreview(
  groupId: string,
  waiting: UnschedulablePods | null,
  held: string | null,
  result: LadderResult,
): ScalingPreviewDto {
  const demand = demandOf(waiting);
  return {
    groupId,
    pending: demand
      ? {
          app: demand.name,
          cpu: `${demand.cpuMillicores}m`,
          memory: `${demand.memoryMi}Mi`,
        }
      : null,
    opportunityHeldBecause: held,
    ladder: result.rungs,
    chosen: result.chosen,
    asks: result.asks,
  };
}

/** A purchase, with everything the thing that buys would need to weigh it. */
function addIntent(rung: LadderRung, fleet: FleetFacts): ScalingIntent {
  return {
    kind: 'add',
    shape: rung.shape,
    region: rung.region,
    hourlyEur: rung.hourlyEur,
    node: null,
    fleetMonthlyEur: fleet.committedMonthlyEur,
    unpricedNodes: fleet.unpricedNodes,
    fleetNodes: fleet.nodes,
  };
}

/**
 * Which node the fleet gives back.
 *
 * The one a standing order named, when it named one. Otherwise the dearest
 * worker: coming back to the target is about the bill, and giving back the
 * cheapest machine of an oversized fleet is the version of this that costs
 * money to run. Never the master, and never a node already leaving.
 */
function pickRemovable(
  rows: ClusterNodeEntity[],
  named: string | null,
): RemovableNode | null {
  const workers = rows.filter(
    (row) =>
      row.nodeType !== NodeType.MASTER && row.status !== NodeStatus.DELETING,
  );
  if (!workers.length) return null;

  const chosen =
    workers.find((row) => row.serverName === named || row.id === named) ??
    [...workers].sort(
      (a, b) =>
        (b.hourlyPriceEur ?? -1) - (a.hourlyPriceEur ?? -1) ||
        a.serverName.localeCompare(b.serverName),
    )[0];

  return {
    id: chosen.id,
    name: chosen.serverName,
    hourlyEur: chosen.hourlyPriceEur ?? null,
  };
}

function toConsidered(rung: LadderRung): ConsideredCandidate {
  return {
    shape: rung.shape,
    region: rung.region,
    hourlyEur: rung.hourlyEur,
    outcome: rung.outcome,
    note: rung.note,
  };
}

function priced(rung: LadderRung): string {
  const monthly = monthlyFrom(rung.hourlyEur);
  return monthly === null
    ? ' (no price published)'
    : ` at €${rung.hourlyEur}/h, about €${monthly} a month`;
}

/**
 * The orders the patient side has open. Where none is written and the fleet
 * sits below its target, the target is itself an order to expand — otherwise
 * `desired` would be a number nothing ever reads.
 */
function openOrders(
  group: ScalingGroupEntity,
  nodes: number,
  input: LadderInput,
): StandingOrderConfig[] {
  const declared = (group.standingOrders ?? []).filter(
    (order) => order.wanted > 0,
  );
  if (declared.length) return declared;
  if (nodes >= group.desiredNodes) return [];

  const shape = input.group.shapes[0];
  const region = input.group.regions[0] ?? input.clusterRegion;
  if (!shape) return [];
  return [
    {
      kind: 'expand',
      shape,
      region,
      wanted: group.desiredNodes - nodes,
      replaces: null,
    },
  ];
}
