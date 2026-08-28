import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../clusters/entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeStatus,
} from '../../clusters/entities/cluster-node.entity';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ScalingDecisionEntity } from '../entities/scaling-decision.entity';
import { ProviderScalingCapability } from '../scaling-capability';
import { fleetOf, roundEur } from '../engine/engine.core';
import { clusterNotFound } from '../scaling-errors';
import { ScalingGroupService } from './scaling-group.service';
import {
  ClusterScalingRowDto,
  OpenAlarmDto,
} from '../dto/scaling-response.dto';

/**
 * One row per cluster, including the clusters a filter would have eaten.
 *
 * A section listing only the clusters with a group would answer "all well" in
 * exactly the two cases where somebody is needed: the cluster nobody set up,
 * and the cluster that can do nothing but raise an alarm.
 */
@Injectable()
export class ScalingOverviewService {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ScalingGroupEntity)
    private readonly groups: Repository<ScalingGroupEntity>,
    @InjectRepository(ScalingDecisionEntity)
    private readonly decisions: Repository<ScalingDecisionEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodes: Repository<ClusterNodeEntity>,
    private readonly groupService: ScalingGroupService,
  ) {}

  async rows(): Promise<ClusterScalingRowDto[]> {
    const clusters = await this.clusters.find({
      where: { status: Not(ClusterStatus.DELETED) },
      order: { createdAt: 'DESC' },
    });
    if (!clusters.length) return [];

    const ids = clusters.map((c) => c.id);
    const groups = await this.groups.find({
      where: { clusterId: In(ids) },
      order: { createdAt: 'ASC' },
    });
    const nodes = await this.nodes.find({
      where: { clusterId: In(ids), status: Not(NodeStatus.DELETING) },
    });

    return Promise.all(clusters.map((c) => this.row(c, groups, nodes)));
  }

  async rowFor(clusterId: string): Promise<ClusterScalingRowDto> {
    const cluster = await this.clusters.findOne({
      where: { id: clusterId, status: Not(ClusterStatus.DELETED) },
    });
    if (!cluster) throw clusterNotFound(clusterId);
    const groups = await this.groups.find({
      where: { clusterId },
      order: { createdAt: 'ASC' },
    });
    const nodes = await this.nodes.find({
      where: { clusterId, status: Not(NodeStatus.DELETING) },
    });
    return this.row(cluster, groups, nodes);
  }

  /**
   * The row names the cluster's first group and carries the rest by name. A
   * cluster may hold several — that is why the group is a resource — and a count
   * on its own leaves the second one unnamed until somebody asks again.
   */
  private async row(
    cluster: ClusterEntity,
    allGroups: ScalingGroupEntity[],
    allNodes: ClusterNodeEntity[],
  ): Promise<ClusterScalingRowDto> {
    const mine = allGroups.filter((g) => g.clusterId === cluster.id);
    const group = mine[0] ?? null;
    const capability = this.groupService.capabilityOf(cluster.provider);
    const fleet = fleetOf(
      allNodes.filter((n) => n.clusterId === cluster.id),
      { nodes: cluster.nodeCount ?? 0, shape: cluster.nodeSize ?? null },
    );
    const current = await this.currentDecisions(mine);
    const openAlarm = openAlarmOf(current);
    const monthlyEur = monthlyEurOf(capability, fleet);

    return {
      clusterId: cluster.id,
      clusterName: cluster.name,
      capability,
      groupId: group?.id ?? null,
      groupCount: mine.length,
      groups: mine.map((g) => ({
        id: g.id,
        name: g.name,
        provision: g.provision,
        bounds: { min: g.minNodes, desired: g.desiredNodes, max: g.maxNodes },
      })),
      bounds: group
        ? {
            min: group.minNodes,
            desired: group.desiredNodes,
            max: group.maxNodes,
          }
        : null,
      nodes: fleet.nodes,
      monthlyEur,
      unpricedNodes: fleet.unpricedNodes,
      monthlyCap: group?.maxMonthlyCost ?? null,
      pendingPods: pendingPodsOf(current),
      acts: this.actsOf(capability, mine),
      openOrders: group?.standingOrders?.length ?? 0,
      blockedOrders: blockedOrdersOf(current),
      openAlarm,
      lastDecisionAt: lastDecisionAt(current),
      needsPerson: needsPerson({
        capability,
        group,
        nodes: fleet.nodes,
        monthlyEur,
        unpricedNodes: fleet.unpricedNodes,
        openAlarm,
      }),
    };
  }

  /**
   * Whether anything this cluster decides would reach a provider.
   *
   * The capability alone answers a different question — what the *provider*
   * allows — and a row that showed only that says "Flui buys" beside a cluster
   * where two pods are stuck and nothing will ever be bought.
   */
  private actsOf(
    capability: ProviderScalingCapability,
    groups: ScalingGroupEntity[],
  ): boolean {
    if (!capability.canProvision) return false;
    return groups.some((group) => group.provision === 'automatic');
  }

  /**
   * What each group of the cluster last decided.
   *
   * The latest row *is* the group's current state, which is the only reading
   * that maintains itself: an alarm stops standing the moment the group decides
   * anything else, including the decline it writes once somebody has attached
   * the machine by hand. An alarm cleared only by an `added` would stand for
   * good wherever nothing adds anything — which is every provider Flui cannot
   * buy from, and the whole population this surface exists for.
   */
  private async currentDecisions(
    groups: ScalingGroupEntity[],
  ): Promise<ScalingDecisionEntity[]> {
    const latest = await Promise.all(
      groups.map((group) =>
        this.decisions.findOne({
          where: { groupId: group.id },
          order: { at: 'DESC' },
        }),
      ),
    );
    return latest.filter((row): row is ScalingDecisionEntity => row !== null);
  }
}

type FleetReading = ReturnType<typeof fleetOf>;

/**
 * What the fleet commits to a month, or nothing at all.
 *
 * Three answers, and two of them are null for different reasons. Where the
 * provider bills nobody the machines are the operator's own and there is no bill
 * to show, permanently — `billing` says so, never the provider's name. Where
 * there is a bill but no node carries a price, there is no figure yet, and a 0
 * would say the fleet is free. Otherwise the priced nodes are summed and
 * `unpricedNodes` says how much of the fleet the figure leaves out.
 */
function monthlyEurOf(
  capability: ProviderScalingCapability,
  fleet: FleetReading,
): number | null {
  if (capability.billing === 'none') return null;
  if (fleet.nodes - fleet.unpricedNodes === 0) return null;
  return roundEur(fleet.committedMonthlyEur);
}

/**
 * What the last pass saw waiting, read from the decision rather than asked
 * again.
 *
 * A list of clusters asking every cluster's API server the same question, once
 * per row, is a page whose speed depends on the slowest cluster in the
 * installation — and whose answer during an outage is a timeout. The pass
 * already asked, on a loop, and wrote down what it heard.
 *
 * Null when no group of this cluster could get an answer, which is not zero:
 * this is the figure the section exists to keep honest.
 */
function pendingPodsOf(current: ScalingDecisionEntity[]): number | null {
  const answered = current
    .map((row) => row.pendingPods)
    .filter((count): count is number => typeof count === 'number');
  return answered.length ? Math.max(...answered) : null;
}

/**
 * Standing orders whose node cannot be emptied.
 *
 * A blocked order is the quietest failure in the whole feature: the group waits
 * for a machine it will never buy, forever, and nothing else on any screen
 * distinguishes that from patience working as designed.
 */
function blockedOrdersOf(current: ScalingDecisionEntity[]): number {
  return current.filter((row) => row.drain && !row.drain.ok).length;
}

function lastDecisionAt(current: ScalingDecisionEntity[]): string | null {
  const newest = current.reduce<Date | null>(
    (latest, row) => (!latest || row.at > latest ? row.at : latest),
    null,
  );
  return newest ? newest.toISOString() : null;
}

/**
 * The longest-standing alarm among the groups still raising one — a row shows a
 * single line, and the one that has gone unanswered longest is what "somebody is
 * needed here" is measuring.
 */
function openAlarmOf(current: ScalingDecisionEntity[]): OpenAlarmDto | null {
  const standing = current
    .filter((row) => row.outcome === 'alerted' && row.asks)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const oldest = standing[0];
  return oldest
    ? { since: oldest.at.toISOString(), asks: oldest.asks ?? '' }
    : null;
}

interface RowFacts {
  capability: { canProvision: boolean };
  group: ScalingGroupEntity | null;
  nodes: number;
  monthlyEur: number | null;
  unpricedNodes: number;
  openAlarm: OpenAlarmDto | null;
}

/** The line that has to read from across the room, or nothing when all is well. */
export function needsPerson(facts: RowFacts): string | null {
  const { group, nodes } = facts;
  if (!group) {
    return 'No scaling group. This cluster will not grow, and nothing will raise an alarm when it should have.';
  }

  const reasons: string[] = [];
  if (nodes < group.minNodes) {
    reasons.push(
      `Below its floor — ${nodes} ${nodes === 1 ? 'node' : 'nodes'} where ${group.minNodes} are required.`,
    );
  }
  if (nodes > group.maxNodes) {
    reasons.push(
      facts.capability.canProvision
        ? `${nodes} nodes against a ceiling of ${group.maxNodes}.`
        : `${nodes} nodes against a ceiling of ${group.maxNodes}. Nothing refused them — they were attached by hand — so the ceiling can only report it.`,
    );
  }
  if (
    facts.monthlyEur !== null &&
    group.maxMonthlyCost !== null &&
    facts.monthlyEur > group.maxMonthlyCost
  ) {
    // The figure only ever understates: an unpriced node adds nothing to it, so
    // being over the ceiling is certain and being under it never was.
    reasons.push(
      facts.unpricedNodes
        ? `Already over its own ceiling of €${group.maxMonthlyCost} a month, and €${facts.monthlyEur} is a floor — ${facts.unpricedNodes} node(s) carry no price.`
        : `Over its own ceiling of €${group.maxMonthlyCost} a month.`,
    );
  }
  if (facts.openAlarm) {
    reasons.push(
      `An alarm raised on ${facts.openAlarm.since.slice(0, 10)} is still open: it stands until this group decides something else.`,
    );
  }

  return reasons.length ? reasons.join(' ') : null;
}
