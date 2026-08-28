import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../clusters/entities/cluster.entity';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ScalingDecisionEntity } from '../entities/scaling-decision.entity';
import { DrainCheck } from '../engine/drain.core';
import {
  ProviderScalingCapability,
  scalingCapabilityOf,
} from '../scaling-capability';
import { StandingOrderConfig } from '../scaling.core';
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
  ScalingGroupResponseDto,
} from '../dto/scaling-response.dto';
import {
  clusterNotFound,
  groupNameTaken,
  groupNotFound,
} from '../scaling-errors';

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
    private readonly capabilities: CapabilitiesProviderFactory,
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

  async listForCluster(clusterId: string): Promise<ScalingGroupResponseDto[]> {
    const cluster = await this.clusterOrFail(clusterId);
    const rows = await this.groups.find({
      where: { clusterId },
      order: { createdAt: 'ASC' },
    });
    const drains = await Promise.all(rows.map((row) => this.lastDrain(row.id)));
    return rows.map((row, index) => this.toDto(row, cluster, drains[index]));
  }

  async get(id: string): Promise<ScalingGroupResponseDto> {
    const group = await this.groupOrFail(id);
    return this.toDto(
      group,
      await this.clusterOrFail(group.clusterId),
      await this.lastDrain(group.id),
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
      where: { groupId },
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
      hourlyBillingOnly: dto.limits?.hourlyBillingOnly ?? false,
      maxMonthlyCost: dto.limits?.maxMonthlyCost ?? null,
      provision: dto.provision ?? 'manual',
      standingOrders: (dto.standingOrders ?? []).map(standingOrder),
      requirement: dto.requirement ?? null,
    });

    this.assertCoherent(draft, capability);
    await this.assertNameFree(clusterId, draft.name, null);

    return this.toDto(await this.groups.save(draft), cluster);
  }

  async update(
    id: string,
    dto: EditScalingGroupDto,
  ): Promise<ScalingGroupResponseDto> {
    const group = await this.groupOrFail(id);
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

    this.assertCoherent(group, capability);
    await this.assertNameFree(group.clusterId, group.name, group.id);

    return this.toDto(await this.groups.save(group), cluster);
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
  async withCluster(
    id: string,
  ): Promise<{ group: ScalingGroupEntity; cluster: ClusterEntity }> {
    const group = await this.groupOrFail(id);
    return { group, cluster: await this.clusterOrFail(group.clusterId) };
  }

  async decisionsOf(
    id: string,
    limit = DEFAULT_DECISION_LIMIT,
  ): Promise<ScalingDecisionResponseDto[]> {
    const group = await this.groupOrFail(id);
    const rows = await this.decisions.find({
      where: { groupId: group.id },
      order: { at: 'DESC' },
      take: bounded(limit),
    });
    return rows.map(toDecisionDto);
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
  ): Promise<ClusterScalingDecisionDto[]> {
    const cluster = await this.clusterOrFail(clusterId);
    const groups = await this.groups.find({
      where: { clusterId: cluster.id },
    });
    const names = new Map(groups.map((group) => [group.id, group.name]));

    const rows = await this.decisions.find({
      where: { clusterId: cluster.id },
      order: { at: 'DESC' },
      take: bounded(limit),
    });
    return rows.map((row) => ({
      ...toDecisionDto(row),
      groupId: row.groupId,
      // A decision outlives nothing here — the group takes its decisions with it
      // when it is removed — so an unnamed group means a row written for a group
      // that no longer answers, not a name worth inventing.
      groupName: names.get(row.groupId) ?? 'removed group',
    }));
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
      if (!group.regions.includes(order.region)) {
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

    if (!capability.canProvision) {
      return {
        acts: false,
        says: `Flui cannot create a server on ${cluster.provider}, so this group decides and a person acts. That is the whole of scaling here, not a step toward it.`,
      };
    }
    if (group.provision !== 'automatic') {
      return {
        acts: false,
        says: 'This group decides and does not act. Set it to buy automatically for anything it decides to reach a provider.',
      };
    }
    return {
      acts: true,
      says:
        group.maxMonthlyCost === null
          ? `This group buys through the provider API on its own, up to ${group.maxNodes} nodes. It names no ceiling in money.`
          : `This group buys through the provider API on its own, up to €${group.maxMonthlyCost} a month and ${group.maxNodes} nodes.`,
    };
  }

  private toDto(
    group: ScalingGroupEntity,
    cluster: ClusterEntity,
    drain: DrainCheck | null = null,
  ): ScalingGroupResponseDto {
    return {
      id: group.id,
      name: group.name,
      clusterId: group.clusterId,
      clusterName: cluster.name,
      provider: cluster.provider,
      capability: this.capabilityOf(cluster.provider),
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
  group.hourlyBillingOnly = limits.hourlyBillingOnly ?? false;
  group.maxMonthlyCost = limits.maxMonthlyCost ?? null;
}

export function toDecisionDto(
  row: ScalingDecisionEntity,
): ScalingDecisionResponseDto {
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
  };
}
