import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { NodeBillableIntervalEntity } from '../entities/node-billable-interval.entity';
import { VolumeBillableIntervalEntity } from '../entities/volume-billable-interval.entity';
import { ProviderFactory } from 'src/modules/providers/services/provider.factory';
import { HetznerProviderService } from 'src/modules/providers/services/hetzner-provider.service';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import {
  ClusterBillingResponseDto,
  NodeMonthToDateDto,
  VolumeMonthToDateDto,
  BillingPeriodDto,
  BillingBreakdownDto,
  TrafficInfoDto,
} from '../dto/cluster-billing.dto';
import {
  Amount,
  ZERO,
  accrueNode,
  accrueVolume,
  addAmount,
  CalendarMonth,
  calendarMonth,
  nodeAmount,
} from '../costs/cost-accrual';
import { billingOf } from '../costs/provider-billing';
import {
  CostRatesService,
  StampedNodePrice,
  StampedVolumePrice,
} from './cost-rates.service';

const MS_PER_HOUR = 3_600_000;

@Injectable()
export class ClusterBillingService {
  private readonly logger = new Logger(ClusterBillingService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(NodeBillableIntervalEntity)
    private readonly nodeIntervalRepo: Repository<NodeBillableIntervalEntity>,
    @InjectRepository(VolumeBillableIntervalEntity)
    private readonly volumeIntervalRepo: Repository<VolumeBillableIntervalEntity>,
    private readonly providerFactory: ProviderFactory,
    private readonly rates: CostRatesService,
  ) {}

  async getClusterBilling(
    clusterId: string,
    now: Date = new Date(),
  ): Promise<ClusterBillingResponseDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const billingPeriod = this.computeBillingPeriod(now);

    // BYOS (and any provider Flui doesn't price): no provider pricing API — you
    // pay your own infra provider, Flui bills nothing — so report zeros, not 500.
    if (!this.rates.isPriced(cluster.provider)) {
      return this.zeroBilling(cluster, billingPeriod, now);
    }

    const month = calendarMonth(now);
    const billing = billingOf(cluster.provider);
    const caps = billing?.capsAtMonthlyPrice ?? false;
    const [nodeIntervals, volumeIntervals, vat] = await Promise.all([
      this.intervalsOf(this.nodeIntervalRepo, cluster.id, month.start, now),
      this.intervalsOf(this.volumeIntervalRepo, cluster.id, month.start, now),
      this.rates.vat(cluster.provider),
    ]);

    const tally = newTally();
    await this.tallyNodes(tally, cluster, nodeIntervals, month, now, caps);
    await this.tallyVolumes(tally, cluster, volumeIntervals, month, now);
    const { spent, forecast, runRate, nodes, volumes } = tally;

    const traffic = await this.computeTraffic(cluster);
    const trafficAmount: Amount = {
      net: Number.parseFloat(traffic.overageCostNet),
      gross: Number.parseFloat(traffic.overageCostGross),
    };

    const monthToDateBreakdown = breakdownOf(
      spent.compute,
      spent.storage,
      trafficAmount,
      4,
    );
    const spentTotal = addAmount(
      addAmount(spent.compute, spent.storage),
      trafficAmount,
    );
    const forecastTotal = addAmount(
      addAmount(forecast.compute, forecast.storage),
      trafficAmount,
    );
    const runRateTotal = addAmount(runRate.compute, runRate.storage);

    return {
      clusterId: cluster.id,
      clusterName: cluster.name,
      provider: cluster.provider,
      region: cluster.region,
      currency: 'EUR',
      billingPeriod,
      monthToDate: {
        totalGross: grossOf(spentTotal).toFixed(4),
        totalNet: spentTotal.net.toFixed(4),
        breakdown: monthToDateBreakdown,
        nodes: [...nodes.values()],
        volumes: [...volumes.values()],
        traffic,
      },
      forecast: {
        totalGross: grossOf(forecastTotal).toFixed(2),
        totalNet: forecastTotal.net.toFixed(2),
        breakdown: breakdownOf(
          forecast.compute,
          forecast.storage,
          trafficAmount,
          2,
        ),
        remainingHours: Math.max(
          0,
          Math.floor((month.end.getTime() - now.getTime()) / MS_PER_HOUR),
        ),
      },
      runRate: {
        monthlyGross: grossOf(runRateTotal).toFixed(2),
        monthlyNet: runRateTotal.net.toFixed(2),
        breakdown: breakdownOf(runRate.compute, runRate.storage, ZERO, 2),
        activeNodes: tally.activeNodes,
        activeVolumes: tally.activeVolumes,
      },
      vat: { included: vat.included, ratePercent: vat.ratePercent },
      billedAs: billing?.billedAs ?? null,
      unpricedItems: tally.unpriced,
      listPricedItems: tally.listPriced,
      calculatedAt: now,
    };
  }

  private async tallyNodes(
    tally: Tally,
    cluster: ClusterEntity,
    intervals: NodeBillableIntervalEntity[],
    month: CalendarMonth,
    now: Date,
    caps: boolean,
  ): Promise<void> {
    for (const iv of intervals) {
      const rate = await this.rates.nodeRate(
        iv.provider || cluster.provider,
        iv.serverType,
        cluster.region,
        iv.location,
        iv.metadata?.price as StampedNodePrice | undefined,
      );
      if (!iv.endedAt) tally.activeNodes++;
      if (!rate) {
        tally.unpriced++;
        this.logger.warn(
          `No price for type=${iv.serverType} region=${cluster.region}: interval ${iv.id} not counted`,
        );
        continue;
      }
      if (rate.basis === 'list') tally.listPriced++;
      const accrual = accrueNode(iv, rate, month, now, caps);
      tally.spent.compute = addAmount(tally.spent.compute, accrual.spent);
      tally.forecast.compute = addAmount(
        tally.forecast.compute,
        accrual.forecast,
      );
      if (!iv.endedAt) {
        tally.runRate.compute = addAmount(
          tally.runRate.compute,
          nodeAmount(rate, month.hours, caps),
        );
      }
      if (accrual.spentHours > 0) {
        this.addSegment(tally.nodes, iv, accrual.spentHours, accrual.spent);
      }
    }
  }

  private async tallyVolumes(
    tally: Tally,
    cluster: ClusterEntity,
    intervals: VolumeBillableIntervalEntity[],
    month: CalendarMonth,
    now: Date,
  ): Promise<void> {
    for (const iv of intervals) {
      const stamped = iv.metadata?.price as StampedVolumePrice | undefined;
      const rate = await this.rates.volumeRate(cluster.provider, stamped);
      if (!iv.endedAt) tally.activeVolumes++;
      if (!rate) {
        tally.unpriced++;
        continue;
      }
      if (!stamped) tally.listPriced++;
      const accrual = accrueVolume(iv, iv.sizeGb, rate, month, now);
      tally.spent.storage = addAmount(tally.spent.storage, accrual.spent);
      tally.forecast.storage = addAmount(
        tally.forecast.storage,
        accrual.forecast,
      );
      if (!iv.endedAt) {
        tally.runRate.storage = addAmount(tally.runRate.storage, {
          net: iv.sizeGb * rate.perGbMonthNet,
          gross:
            rate.perGbMonthGross === null
              ? null
              : iv.sizeGb * rate.perGbMonthGross,
        });
      }
      if (accrual.spentHours > 0) {
        this.addVolume(tally.volumes, iv, accrual.spent);
      }
    }
  }

  private intervalsOf<
    T extends { clusterId: string; startedAt: Date; endedAt?: Date | null },
  >(
    repo: Repository<T>,
    clusterId: string,
    from: Date,
    to: Date,
  ): Promise<T[]> {
    return repo
      .createQueryBuilder('interval')
      .where('interval.clusterId = :clusterId', { clusterId })
      .andWhere('interval.startedAt <= :to', { to })
      .andWhere('(interval.endedAt IS NULL OR interval.endedAt >= :from)', {
        from,
      })
      .orderBy('interval.startedAt', 'ASC')
      .getMany();
  }

  private addSegment(
    nodes: Map<string, NodeMonthToDateDto>,
    iv: NodeBillableIntervalEntity,
    hours: number,
    cost: Amount,
  ): void {
    const segment = {
      serverType: iv.serverType,
      startedAt: iv.startedAt.toISOString(),
      endedAt: iv.endedAt ? iv.endedAt.toISOString() : null,
      hours,
      costGross: grossOf(cost).toFixed(4),
      costNet: cost.net.toFixed(4),
    };
    const existing = nodes.get(iv.nodeId);
    if (existing) {
      existing.billableHours += hours;
      existing.costGross = (
        Number.parseFloat(existing.costGross) + grossOf(cost)
      ).toFixed(4);
      existing.costNet = (
        Number.parseFloat(existing.costNet) + cost.net
      ).toFixed(4);
      existing.currentServerType = iv.serverType;
      existing.status = iv.endedAt ? 'terminated' : 'active';
      existing.segments.push(segment);
      return;
    }
    nodes.set(iv.nodeId, {
      nodeId: iv.nodeId,
      serverName: iv.serverName,
      nodeType: iv.nodeType,
      currentServerType: iv.serverType,
      providerResourceId: iv.providerResourceId ?? null,
      status: iv.endedAt ? 'terminated' : 'active',
      billableHours: hours,
      costGross: segment.costGross,
      costNet: segment.costNet,
      segments: [segment],
    });
  }

  private addVolume(
    volumes: Map<string, VolumeMonthToDateDto>,
    iv: VolumeBillableIntervalEntity,
    cost: Amount,
  ): void {
    const existing = volumes.get(iv.volumeProviderId);
    if (existing) {
      existing.costGross = (
        Number.parseFloat(existing.costGross) + grossOf(cost)
      ).toFixed(4);
      existing.costNet = (
        Number.parseFloat(existing.costNet) + cost.net
      ).toFixed(4);
      existing.currentSizeGb = iv.sizeGb;
      existing.status = iv.endedAt ? 'terminated' : 'active';
      return;
    }
    volumes.set(iv.volumeProviderId, {
      volumeProviderId: iv.volumeProviderId,
      kind: iv.kind,
      currentSizeGb: iv.sizeGb,
      status: iv.endedAt ? 'terminated' : 'active',
      costGross: grossOf(cost).toFixed(4),
      costNet: cost.net.toFixed(4),
    });
  }

  // ─── Traffic (Hetzner only, current snapshot) ──────────────────────────────

  private async computeTraffic(
    cluster: ClusterEntity,
  ): Promise<TrafficInfoDto> {
    if (cluster.provider !== CloudProvider.HETZNER) {
      return this.zeroTraffic();
    }
    const hetzner = this.providerFactory.getProvider(
      CloudProvider.HETZNER,
    ) as unknown as HetznerProviderService;
    const openNodes = await this.nodeIntervalRepo.find({
      where: { clusterId: cluster.id, endedAt: IsNull() },
    });
    let outgoingBytes = 0;
    let ingoingBytes = 0;
    let includedBytes = 0;
    let overageBytes = 0;
    const overageGross = 0;
    const overageNet = 0;
    for (const node of openNodes) {
      if (!node.providerResourceId) continue;
      try {
        const raw = await hetzner.getServerDetails(node.providerResourceId);
        if (!raw) continue;
        outgoingBytes += raw.outgoing_traffic ?? 0;
        ingoingBytes += raw.ingoing_traffic ?? 0;
        includedBytes += raw.included_traffic ?? 0;
        const nodeOverage = Math.max(
          0,
          (raw.outgoing_traffic ?? 0) - (raw.included_traffic ?? 0),
        );
        overageBytes += nodeOverage;
        // Hetzner pricing payload exposes per-TB traffic; our cache doesn't
        // store it because getNodeSizes doesn't expose it. Leave overage cost
        // at 0 until we extend the pricing fetch.
      } catch (err) {
        this.logger.warn(
          `traffic detail fetch failed: ${(err as Error).message}`,
        );
      }
    }
    return {
      outgoingBytes,
      ingoingBytes,
      includedBytes,
      overageBytes,
      overageCostGross: overageGross.toFixed(4),
      overageCostNet: overageNet.toFixed(4),
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private zeroTraffic(): TrafficInfoDto {
    return {
      outgoingBytes: 0,
      ingoingBytes: 0,
      includedBytes: 0,
      overageBytes: 0,
      overageCostGross: '0.0000',
      overageCostNet: '0.0000',
    };
  }

  private zeroBilling(
    cluster: ClusterEntity,
    billingPeriod: BillingPeriodDto,
    now: Date,
  ): ClusterBillingResponseDto {
    const zeroBreakdown: BillingBreakdownDto = {
      computeGross: '0.0000',
      computeNet: '0.0000',
      storageGross: '0.0000',
      storageNet: '0.0000',
      trafficGross: '0.0000',
      trafficNet: '0.0000',
    };
    return {
      clusterId: cluster.id,
      clusterName: cluster.name,
      provider: cluster.provider,
      region: cluster.region,
      currency: 'EUR',
      billingPeriod,
      monthToDate: {
        totalGross: '0.0000',
        totalNet: '0.0000',
        breakdown: zeroBreakdown,
        nodes: [],
        volumes: [],
        traffic: this.zeroTraffic(),
      },
      runRate: {
        monthlyGross: '0.00',
        monthlyNet: '0.00',
        breakdown: {
          computeGross: '0.00',
          computeNet: '0.00',
          storageGross: '0.00',
          storageNet: '0.00',
          trafficGross: '0.00',
          trafficNet: '0.00',
        },
        activeNodes: 0,
        activeVolumes: 0,
      },
      forecast: {
        totalGross: '0.00',
        totalNet: '0.00',
        breakdown: breakdownOf(ZERO, ZERO, ZERO, 2),
        remainingHours: 0,
      },
      vat: { included: false, ratePercent: null },
      billedAs: null,
      unpricedItems: 0,
      listPricedItems: 0,
      calculatedAt: now,
    };
  }

  private computeBillingPeriod(now: Date): BillingPeriodDto {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999),
    );
    const totalHours = Math.ceil(
      (end.getTime() - start.getTime()) / MS_PER_HOUR,
    );
    const elapsedHours = Math.ceil(
      (now.getTime() - start.getTime()) / MS_PER_HOUR,
    );
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      totalHours,
      elapsedHours,
    };
  }
}

interface Split {
  compute: Amount;
  storage: Amount;
}

interface Tally {
  spent: Split;
  forecast: Split;
  runRate: Split;
  nodes: Map<string, NodeMonthToDateDto>;
  volumes: Map<string, VolumeMonthToDateDto>;
  activeNodes: number;
  activeVolumes: number;
  unpriced: number;
  listPriced: number;
}

function newTally(): Tally {
  const split = (): Split => ({ compute: { ...ZERO }, storage: { ...ZERO } });
  return {
    spent: split(),
    forecast: split(),
    runRate: split(),
    nodes: new Map(),
    volumes: new Map(),
    activeNodes: 0,
    activeVolumes: 0,
    unpriced: 0,
    listPriced: 0,
  };
}

function grossOf(amount: Amount): number {
  return amount.gross ?? amount.net;
}

function breakdownOf(
  compute: Amount,
  storage: Amount,
  traffic: Amount,
  decimals: number,
): BillingBreakdownDto {
  return {
    computeGross: grossOf(compute).toFixed(decimals),
    computeNet: compute.net.toFixed(decimals),
    storageGross: grossOf(storage).toFixed(decimals),
    storageNet: storage.net.toFixed(decimals),
    trafficGross: grossOf(traffic).toFixed(decimals),
    trafficNet: traffic.net.toFixed(decimals),
  };
}
