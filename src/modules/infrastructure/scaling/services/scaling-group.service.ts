import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../clusters/entities/cluster.entity';
import { VNetSubnetEntity } from '../../vnets/entities/vnet-subnet.entity';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ScalingDecisionEntity } from '../entities/scaling-decision.entity';
import { DrainCheck } from '../engine/drain.core';
import {
  ProviderScalingCapability,
  buyableRegionsOf,
  scalingCapabilityOf,
} from '../scaling-capability';
import {
  ANY_REGION,
  NOT_ENGINE_FORCES,
  StandingOrderConfig,
} from '../scaling.core';
import { PurchaseHold, purchaseHold } from '../engine/purchase-hold';
import {
  InfrastructureOperationEntity,
  OperationStatus,
} from '../../servers/entities/infrastructure-operations.entity';
import {
  EditScalingGroupDto,
  ScalingLimitsDto,
  StandingOrderDto,
  WriteScalingGroupDto,
} from '../dto/scaling-group.dto';
import {
  ClusterScalingDecisionDto,
  ScalingActuationDto,
  ScalingDecisionResponseDto,
  DecisionOperationDto,
  ScalingGroupResponseDto,
  PurchaseInFlightDto,
} from '../dto/scaling-response.dto';
import { scalingModeLabel } from '../scaling-consequence';
import {
  clusterNotFound,
  groupNameTaken,
  groupNotFound,
} from '../scaling-errors';
import { groupChanges, snapshotOf } from './group-changes.core';
import { DecisionFilter, decisionWhere } from './decision-filter.core';
import { collapseRepeats } from './collapse-decisions.core';
import {
  ClusterNodeEntity,
  NodeType,
} from '../../clusters/entities/cluster-node.entity';

const DEFAULT_DECISION_LIMIT = 50;
const MAX_DECISION_LIMIT = 200;

/**
 * The group as a resource: written, read, listed — and acting on nothing.
 *
 * What it does enforce is the set of statements the object is not allowed to
 * make, and all of them come from the provider's declarations rather than its
 * name: a group cannot promise to buy where nothing can be bought, cannot name
 * a shape where no catalogue publishes one, and cannot say what a machine must
 * hold where the shapes already say it with a price attached.
 */
@Injectable()
export class ScalingGroupService {
  constructor(
    @InjectRepository(ScalingGroupEntity)
    private readonly groups: Repository<ScalingGroupEntity>,
    @InjectRepository(ScalingDecisionEntity)
    private readonly decisions: Repository<ScalingDecisionEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(VNetSubnetEntity)
    private readonly subnets: Repository<VNetSubnetEntity>,
    private readonly capabilities: CapabilitiesProviderFactory,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodes: Repository<ClusterNodeEntity>,
  ) {}

  capabilityOf(provider: string): ProviderScalingCapability {
    const known = this.capabilities.isProviderSupported(
      provider as CloudProvider,
    );
    return scalingCapabilityOf(
      provider,
      known
        ? this.capabilities
            .getCapabilitiesService(provider as CloudProvider)
            .getStaticCapabilities()
        : null,
    );
  }

  /**
   * The network zone this cluster's own subnet sits in.
   *
   * Read from the subnet rather than the provider: a cluster has the network it
   * was given, and on a provider whose zones group several regions that is the
   * only thing that says which group it landed in. Null where the cluster has
   * no subnet recorded, which every caller treats as "unknown", never as "any".
   */
  private async zoneOf(cluster: ClusterEntity): Promise<string | null> {
    const subnetId = (
      cluster.metadata as { vnetConfig?: { subnetId?: string } } | undefined
    )?.vnetConfig?.subnetId;
    if (!subnetId) return null;
    const subnet = await this.subnets.findOne({ where: { id: subnetId } });
    return subnet?.networkZone ?? null;
  }

  /** Where a node bought for this cluster could actually join it from. */
  async buyableFor(cluster: ClusterEntity): Promise<string[] | null> {
    const known = this.capabilities.isProviderSupported(
      cluster.provider as CloudProvider,
    );
    return buyableRegionsOf(
      cluster,
      known
        ? this.capabilities
            .getCapabilitiesService(cluster.provider as CloudProvider)
            .getStaticCapabilities()
        : null,
      await this.zoneOf(cluster),
    );
  }

  async listForCluster(clusterId: string): Promise<ScalingGroupResponseDto[]> {
    const cluster = await this.clusterOrFail(clusterId);
    const rows = await this.groups.find({
      where: { clusterId },
      order: { createdAt: 'ASC' },
    });
    const drains = await Promise.all(rows.map((row) => this.lastDrain(row.id)));
    const holds = await Promise.all(rows.map((row) => this.holdOf(row)));
    const purchases = await Promise.all(
      rows.map((row) => this.purchaseOf(row)),
    );
    const buyable = await this.buyableFor(cluster);
    return rows.map((row, index) =>
      this.toDto(
        row,
        cluster,
        drains[index],
        buyable,
        holds[index],
        purchases[index],
      ),
    );
  }

  async get(id: string): Promise<ScalingGroupResponseDto> {
    const group = await this.groupOrFail(id);
    const cluster = await this.clusterOrFail(group.clusterId);
    return this.toDto(
      group,
      cluster,
      await this.lastDrain(group.id),
      await this.buyableFor(cluster),
      await this.holdOf(group),
      await this.purchaseOf(group),
    );
  }

  /**
   * Lets a group buy again after a purchase failed. Only the timestamp moves:
   * whether anything is bought is still the next pass's decision, inside the
   * group's own bounds and ceiling.
   */
  async retryPurchase(
    id: string,
    by = 'a person',
  ): Promise<ScalingGroupResponseDto> {
    const group = await this.groupOrFail(id);
    const hold = await this.holdOf(group);
    group.purchaseRetryAt = new Date();
    await this.groups.save(group);
    const reason = hold?.error
      ? ' (' + withoutTrailingStops(hold.error) + ')'
      : '';
    await this.recordPerson(
      group,
      `${by} let the group buy again.`,
      hold
        ? `The purchase that failed at ${hold.failedAt.toISOString().slice(11, 16)} UTC no longer holds it back${reason}.`
        : 'Nothing was holding it back.',
      by,
    );
    return this.get(id);
  }

  /**
   * One row in the decision log for what a person did to the group, so a
   * purchase can be read against the rules it was made under.
   */
  private async recordPerson(
    group: ScalingGroupEntity,
    did: string,
    detail: string,
    by: string,
  ): Promise<void> {
    await this.decisions.save(
      this.decisions.create({
        groupId: group.id,
        clusterId: group.clusterId,
        at: new Date(),
        force: 'person',
        outcome: 'changed',
        saw: `${by} changed the group.`,
        did,
        why: detail,
        asks: null,
        shape: null,
        region: null,
        hourlyPriceEur: null,
        considered: [],
        pendingPods: null,
        drain: null,
        operationId: null,
      }),
    );
  }

  private async operationsOf(
    rows: ScalingDecisionEntity[],
  ): Promise<Map<string, InfrastructureOperationEntity>> {
    const ids = [
      ...new Set(rows.map((row) => row.operationId).filter(Boolean)),
    ] as string[];
    if (!ids.length) return new Map();
    const found = await this.operations.find({ where: { id: In(ids) } });
    return new Map(found.map((op) => [op.id, op]));
  }

  private async purchaseOf(
    group: ScalingGroupEntity,
  ): Promise<PurchaseInFlightDto | null> {
    const [last] = await this.decisions.find({
      where: {
        groupId: group.id,
        operationId: Not(IsNull()),
        outcome: In(['added', 'replaced']),
      },
      order: { at: 'DESC' },
      take: 1,
    });
    if (!last?.operationId) return null;
    const operation = await this.operations.findOne({
      where: { id: last.operationId },
    });
    return operation
      ? purchaseInFlight(last, decisionOperation(operation), new Date())
      : null;
  }

  private holdOf(group: ScalingGroupEntity): Promise<PurchaseHold | null> {
    return purchaseHold(
      this.operations,
      group.clusterId,
      group.purchaseRetryAt,
    );
  }

  /**
   * Whether the node this group would empty could be emptied, as of the last
   * pass — the reading the loop already took, rather than one taken again here.
   *
   * Null covers three different things and deliberately reads as one: no pass
   * has run, the last pass had nothing to drain, or the cluster could not be
   * asked. None of them is an answer, and a screen that turned any of them into
   * "yes" would be inventing the one fact this check exists to establish.
   */
  private async lastDrain(groupId: string): Promise<DrainCheck | null> {
    const last = await this.decisions.findOne({
      where: { groupId, force: Not(In(NOT_ENGINE_FORCES)) },
      order: { at: 'DESC' },
    });
    return last?.drain ?? null;
  }

  async create(
    clusterId: string,
    dto: WriteScalingGroupDto,
  ): Promise<ScalingGroupResponseDto> {
    const cluster = await this.clusterOrFail(clusterId);
    const capability = this.capabilityOf(cluster.provider);

    const draft = this.groups.create({
      clusterId,
      name: dto.name.trim(),
      minNodes: dto.bounds.min,
      desiredNodes: dto.bounds.desired,
      maxNodes: dto.bounds.max,
      regions: dto.regions ?? [],
      shapes: dto.shapes ?? [],
      strategy: dto.strategy ?? 'uniform',
      settleSeconds: dto.settleSeconds ?? 30,
      hourlyBillingOnly: dto.limits?.hourlyBillingOnly ?? true,
      maxMonthlyCost: dto.limits?.maxMonthlyCost ?? null,
      provision: dto.provision ?? 'manual',
      standingOrders: (dto.standingOrders ?? []).map(standingOrder),
      requirement: dto.requirement ?? null,
    });

    const buyable = await this.buyableFor(cluster);
    this.assertCoherent(draft, capability, hasVnet(cluster), buyable);
    await this.resolveReplacedNodes(draft, clusterId);
    await this.assertNameFree(clusterId, draft.name, null);

    return this.toDto(await this.groups.save(draft), cluster, null, buyable);
  }

  async update(
    id: string,
    dto: EditScalingGroupDto,
    by = 'a person',
  ): Promise<ScalingGroupResponseDto> {
    const group = await this.groupOrFail(id);
    const before = snapshotOf(group);
    const cluster = await this.clusterOrFail(group.clusterId);
    const capability = this.capabilityOf(cluster.provider);

    // Present, never truthy: an empty list and a zero are values somebody sent,
    // and a field left alone is one that was left out.
    if (dto.name !== undefined) group.name = dto.name.trim();
    if (dto.bounds !== undefined) {
      group.minNodes = dto.bounds.min;
      group.desiredNodes = dto.bounds.desired;
      group.maxNodes = dto.bounds.max;
    }
    if (dto.regions !== undefined) group.regions = dto.regions;
    if (dto.shapes !== undefined) group.shapes = dto.shapes;
    if (dto.strategy !== undefined) group.strategy = dto.strategy;
    if (dto.settleSeconds !== undefined) {
      group.settleSeconds = dto.settleSeconds;
    }
    if (dto.limits !== undefined) applyLimits(group, dto.limits);
    if (dto.provision !== undefined) group.provision = dto.provision;
    if (dto.standingOrders !== undefined) {
      group.standingOrders = dto.standingOrders.map(standingOrder);
    }
    if (dto.requirement !== undefined) {
      group.requirement = dto.requirement ?? null;
    }

    const buyable = await this.buyableFor(cluster);
    this.assertCoherent(group, capability, hasVnet(cluster), buyable);
    if (dto.standingOrders !== undefined) {
      await this.resolveReplacedNodes(group, group.clusterId);
    }
    await this.assertNameFree(group.clusterId, group.name, group.id);

    const saved = await this.groups.save(group);
    const changes = groupChanges(before, snapshotOf(saved));
    if (changes.length) {
      await this.recordPerson(
        saved,
        `${by} changed ${changes.length === 1 ? 'one setting' : changes.length + ' settings'}.`,
        `${changes.join('; ')}.`,
        by,
      );
    }
    return this.toDto(saved, cluster, null, buyable, await this.holdOf(saved));
  }

  /**
   * The decisions go with it: they are what this group saw and chose, and
   * nothing else can answer for them once it is gone.
   */
  async remove(id: string): Promise<void> {
    const group = await this.groupOrFail(id);
    await this.decisions.delete({ groupId: group.id });
    await this.groups.delete({ id: group.id });
  }

  /** The stored row beside its cluster, for the engine that reads both. */
  async ofCluster(
    clusterId: string,
  ): Promise<{ cluster: ClusterEntity; groups: ScalingGroupEntity[] }> {
    const cluster = await this.clusterOrFail(clusterId);
    const groups = await this.groups.find({
      where: { clusterId },
      order: { createdAt: 'ASC' },
    });
    return { cluster, groups };
  }

  async withCluster(
    id: string,
  ): Promise<{ group: ScalingGroupEntity; cluster: ClusterEntity }> {
    const group = await this.groupOrFail(id);
    return { group, cluster: await this.clusterOrFail(group.clusterId) };
  }

  async decisionsOf(
    id: string,
    limit = DEFAULT_DECISION_LIMIT,
    filter: DecisionFilter = {},
  ): Promise<ScalingDecisionResponseDto[]> {
    const group = await this.groupOrFail(id);
    const rows = await this.decisions.find({
      where: { groupId: group.id, ...decisionWhere(filter) },
      order: { at: 'DESC' },
      take: bounded(limit),
    });
    const operations = await this.operationsOf(rows);
    const dtos = rows.map((row) => toDecisionDto(row, operations));
    return filter.collapse ? collapseRepeats(dtos) : dtos;
  }

  /**
   * What was last decided on this cluster, whichever group decided it.
   *
   * The question is asked of a cluster — *why did nothing happen* — and making
   * it resolve a group first turns two groups into a choice somebody has to make
   * before they are allowed to find out. The group each decision came from
   * travels on the row instead.
   */
  async decisionsOfCluster(
    clusterId: string,
    limit = DEFAULT_DECISION_LIMIT,
    filter: DecisionFilter = {},
  ): Promise<ClusterScalingDecisionDto[]> {
    const cluster = await this.clusterOrFail(clusterId);
    const groups = await this.groups.find({
      where: { clusterId: cluster.id },
    });
    const names = new Map(groups.map((group) => [group.id, group.name]));

    const rows = await this.decisions.find({
      where: { clusterId: cluster.id, ...decisionWhere(filter) },
      order: { at: 'DESC' },
      take: bounded(limit),
    });
    const operations = await this.operationsOf(rows);
    const dtos = rows.map((row) => ({
      ...toDecisionDto(row, operations),
      groupId: row.groupId,
      // A decision outlives nothing here — the group takes its decisions with it
      // when it is removed — so an unnamed group means a row written for a group
      // that no longer answers, not a name worth inventing.
      groupName: names.get(row.groupId) ?? 'removed group',
    }));
    return filter.collapse ? collapseRepeats(dtos) : dtos;
  }

  private async clusterOrFail(clusterId: string): Promise<ClusterEntity> {
    const cluster = await this.clusters.findOne({
      where: { id: clusterId, status: Not(ClusterStatus.DELETED) },
    });
    if (!cluster) throw clusterNotFound(clusterId);
    return cluster;
  }

  private async groupOrFail(id: string): Promise<ScalingGroupEntity> {
    const group = await this.groups.findOne({ where: { id } });
    if (!group) throw groupNotFound(id);
    return group;
  }

  private async assertNameFree(
    clusterId: string,
    name: string,
    selfId: string | null,
  ): Promise<void> {
    const clash = await this.groups.findOne({ where: { clusterId, name } });
    if (clash && clash.id !== selfId) {
      throw groupNameTaken(clusterId, name);
    }
  }

  private assertCoherent(
    group: ScalingGroupEntity,
    capability: ProviderScalingCapability,
    hasVnet: boolean,
    buyableRegions: string[] | null,
  ): void {
    if (!group.name) {
      throw new BadRequestException('A scaling group needs a name');
    }

    if (group.minNodes > group.desiredNodes) {
      throw new BadRequestException(
        'The floor cannot sit above the target: min must be <= desired',
      );
    }
    if (group.desiredNodes > group.maxNodes) {
      throw new BadRequestException(
        'The target cannot sit above the ceiling: desired must be <= max',
      );
    }

    if (group.provision === 'automatic' && !capability.canProvision) {
      throw new BadRequestException(
        `${capability.provider} has no API to create servers: this group can only ask a person, so provision must be "manual"`,
      );
    }

    // A cluster with no VNet refuses every node the fence is asked for, so an
    // automatic group on one would buy nothing and raise the same failed alarm
    // every hour. Refused at the point the promise is made instead.
    if (group.provision === 'automatic' && !hasVnet) {
      throw new BadRequestException(
        'This cluster has no VNet, so no node can join it: attach one before letting scaling buy, or leave this group on "manual"',
      );
    }

    // A node joins its siblings over the cluster's private network, and a
    // region outside that network's reach buys a machine that never arrives:
    // the purchase succeeds, the node never joins, and the group keeps paying
    // for it. Refused where it is written rather than discovered there.
    if (buyableRegions) {
      const unreachable = group.regions.filter(
        (region) => !buyableRegions.includes(region),
      );
      if (unreachable.length) {
        throw new BadRequestException(
          `A node bought in ${unreachable.join(', ')} could not join this cluster: ` +
            `its private network reaches ${buyableRegions.join(', ')} and nowhere else`,
        );
      }
    }

    this.assertCatalogueCoherent(group, capability);
    this.assertOrdersCoherent(group);
  }

  private assertCatalogueCoherent(
    group: ScalingGroupEntity,
    capability: ProviderScalingCapability,
  ): void {
    if (capability.hasCatalogue) {
      if (group.requirement) {
        throw new BadRequestException(
          `${capability.provider} publishes a catalogue: name the shapes it may buy instead of what a machine must hold`,
        );
      }
      return;
    }

    if (group.shapes.length || group.regions.length) {
      throw new BadRequestException(
        `${capability.provider} publishes no catalogue: there is no shape or region to name here`,
      );
    }
    if (!group.requirement) {
      throw new BadRequestException(
        `${capability.provider} publishes no catalogue: state what a machine has to hold, since no shape can be named`,
      );
    }
  }

  /**
   * A replacement names a node of this cluster, by name or id, and is kept by
   * name — the name is what the engine and every page match it against. A
   * reference to nothing would silently turn the drain into an ordinary
   * scale-in of whichever node is dearest.
   */
  private async resolveReplacedNodes(
    group: ScalingGroupEntity,
    clusterId: string,
  ): Promise<void> {
    const orders = group.standingOrders.filter(
      (o) => o.kind === 'replace' && o.replaces,
    );
    if (!orders.length) return;
    const nodes = await this.nodes.find({
      where: { clusterId },
      select: { id: true, serverName: true, nodeType: true },
    });
    for (const order of orders) {
      const node = nodes.find(
        (n) => n.serverName === order.replaces || n.id === order.replaces,
      );
      if (!node) {
        throw new BadRequestException(
          `A replacement names "${order.replaces}", which is not a node of this cluster. Name it as \`flui node list\` shows it.`,
        );
      }
      if (node.nodeType === NodeType.MASTER) {
        throw new BadRequestException(
          `${node.serverName} is the master: it cannot be drained and given back.`,
        );
      }
      order.replaces = node.serverName;
    }
  }

  /**
   * A standing order may only wait for something the group is allowed to buy.
   * An order naming a shape outside `shapes` is a purchase the group would
   * refuse the moment the shape came back — a wait that can never end.
   */
  private assertOrdersCoherent(group: ScalingGroupEntity): void {
    for (const order of group.standingOrders) {
      if (order.kind === 'expand' && order.replaces) {
        throw new BadRequestException(
          'An expansion buys and adds: it drains nothing, so it names no node to replace',
        );
      }
      if (order.kind === 'replace' && !order.replaces) {
        throw new BadRequestException(
          'A replacement has to name the node it would drain and remove',
        );
      }
      if (!group.shapes.includes(order.shape)) {
        throw new BadRequestException(
          `Standing order waits for "${order.shape}", which this group may not buy`,
        );
      }
      if (
        order.region !== ANY_REGION &&
        !group.regions.includes(order.region)
      ) {
        throw new BadRequestException(
          `Standing order waits in "${order.region}", where this group may not buy`,
        );
      }
    }
  }

  /**
   * Whether anything this group decides would reach a provider.
   *
   * Derived on every read rather than stored: it is a fact about the provider
   * and one field of the group, and a copy kept in a row would go on claiming a
   * purchase after somebody set the group back to deciding.
   */
  private actuationOf(
    group: ScalingGroupEntity,
    cluster: ClusterEntity,
  ): ScalingActuationDto {
    const capability = this.capabilityOf(cluster.provider);
    const named = scalingModeLabel({
      provider: cluster.provider,
      canProvision: capability.canProvision,
      provision: group.provision,
      maxMonthlyCost: group.maxMonthlyCost,
      maxNodes: group.maxNodes,
    });

    if (!capability.canProvision) {
      return {
        acts: false,
        says: `Flui cannot create a server on ${cluster.provider}, so this group decides and a person acts. That is the whole of scaling here, not a step toward it.`,
        ...named,
      };
    }
    if (group.provision !== 'automatic') {
      return {
        acts: false,
        says: 'Flui names the machine it would buy and a person buys it, or switches the group to automatic. Nothing is bought on its own.',
        ...named,
      };
    }
    return {
      acts: true,
      says:
        group.maxMonthlyCost === null
          ? `This group buys through the provider API on its own, up to ${group.maxNodes} nodes. It names no ceiling in money.`
          : `This group buys through the provider API on its own, up to €${group.maxMonthlyCost} a month and ${group.maxNodes} nodes.`,
      ...named,
    };
  }

  private toDto(
    group: ScalingGroupEntity,
    cluster: ClusterEntity,
    drain: DrainCheck | null = null,
    buyableRegions: string[] | null = null,
    hold: PurchaseHold | null = null,
    purchase: PurchaseInFlightDto | null = null,
  ): ScalingGroupResponseDto {
    return {
      id: group.id,
      name: group.name,
      clusterId: group.clusterId,
      clusterName: cluster.name,
      provider: cluster.provider,
      capability: this.capabilityOf(cluster.provider),
      buyableRegions,
      bounds: {
        min: group.minNodes,
        desired: group.desiredNodes,
        max: group.maxNodes,
      },
      regions: group.regions ?? [],
      shapes: group.shapes ?? [],
      strategy: group.strategy,
      settleSeconds: group.settleSeconds,
      limits: {
        hourlyBillingOnly: group.hourlyBillingOnly,
        maxMonthlyCost: group.maxMonthlyCost,
      },
      provision: group.provision,
      acts: this.actuationOf(group, cluster),
      standingOrders: (group.standingOrders ?? []).map((order) => ({
        ...order,
        replaces: order.replaces ?? null,
        // Read from the catalogue at the moment of acting, and a stored copy
        // would be a stale one.
        outlook: null,
        // An expansion drains nothing, so there is nothing to answer about it.
        drainable: order.kind === 'replace' ? drain : null,
      })),
      requirement: group.requirement ?? null,
      purchaseHeld: hold
        ? {
            failedAt: hold.failedAt.toISOString(),
            error: hold.error,
            until: hold.until?.toISOString() ?? null,
          }
        : null,
      purchase,
    };
  }
}

function bounded(limit: number): number {
  return Math.min(Math.max(limit, 1), MAX_DECISION_LIMIT);
}

function standingOrder(dto: StandingOrderDto): StandingOrderConfig {
  return {
    kind: dto.kind,
    shape: dto.shape,
    region: dto.region,
    wanted: dto.wanted,
    replaces: dto.replaces ?? null,
  };
}

/** The block is replaced whole, so an omitted cap is a cap removed. */
function applyLimits(
  group: ScalingGroupEntity,
  limits: ScalingLimitsDto,
): void {
  group.hourlyBillingOnly = limits.hourlyBillingOnly ?? true;
  group.maxMonthlyCost = limits.maxMonthlyCost ?? null;
}

export function toDecisionDto(
  row: ScalingDecisionEntity,
  operations: Map<string, InfrastructureOperationEntity> = new Map(),
): ScalingDecisionResponseDto {
  const operation = row.operationId ? operations.get(row.operationId) : null;
  return {
    id: row.id,
    at: row.at.toISOString(),
    force: row.force,
    outcome: row.outcome,
    saw: row.saw,
    did: row.did,
    why: row.why,
    asks: row.asks ?? null,
    shape: row.shape ?? null,
    region: row.region ?? null,
    hourlyEur: row.hourlyPriceEur,
    considered: row.considered ?? [],
    operation: operation ? decisionOperation(operation) : null,
  };
}

const OPERATION_STATE: Record<OperationStatus, DecisionOperationDto['state']> =
  {
    [OperationStatus.PENDING]: 'pending',
    [OperationStatus.IN_PROGRESS]: 'running',
    [OperationStatus.COMPLETED]: 'completed',
    [OperationStatus.FAILED]: 'failed',
    [OperationStatus.CANCELLED]: 'cancelled',
  };

function decisionOperation(
  op: InfrastructureOperationEntity,
): DecisionOperationDto {
  const step = (op.metadata as { message?: unknown } | null)?.message;
  return {
    id: op.id,
    state: OPERATION_STATE[op.status] ?? 'running',
    progress: op.progress ?? 0,
    step: typeof step === 'string' ? step : null,
    error: op.errorMessage ?? null,
    finishedAt: op.completedAt ? new Date(op.completedAt).toISOString() : null,
  };
}

/** A cluster with no private network cannot take a new node, whoever asks for it. */
function hasVnet(cluster: {
  metadata?: { vnetConfig?: { vnetId?: string } };
}): boolean {
  return Boolean(cluster.metadata?.vnetConfig?.vnetId);
}

const PURCHASE_SHOWN_FOR_MS = 30 * 60 * 1000;

export function purchaseInFlight(
  decision: Pick<ScalingDecisionEntity, 'id' | 'at' | 'shape' | 'region'>,
  operation: DecisionOperationDto,
  now: Date,
): PurchaseInFlightDto | null {
  const machine = `${decision.shape ?? 'a node'}${decision.region ? ' in ' + decision.region : ''}`;
  const base = {
    decisionId: decision.id,
    decidedAt: decision.at.toISOString(),
    shape: decision.shape ?? null,
    region: decision.region ?? null,
    operation,
  };
  if (operation.state === 'pending' || operation.state === 'running') {
    const step = operation.step ?? 'starting';
    return {
      ...base,
      state: 'buying',
      says: `Buying ${machine} — ${step} (${operation.progress}%)`,
    };
  }
  const finished = operation.finishedAt ? new Date(operation.finishedAt) : null;
  if (!finished || now.getTime() - finished.getTime() > PURCHASE_SHOWN_FOR_MS) {
    return null;
  }
  if (operation.state === 'completed') {
    const minutes = Math.max(
      1,
      Math.round((finished.getTime() - decision.at.getTime()) / 60000),
    );
    return {
      ...base,
      state: 'joined',
      says: `${machine} joined, ${minutes} min after it was ordered`,
    };
  }
  return {
    ...base,
    state: 'failed',
    says: `Buying ${machine} failed${operation.error ? ': ' + operation.error : ''}`,
  };
}

function withoutTrailingStops(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || /\s/.test(text[end - 1]))) end--;
  return text.slice(0, end);
}
