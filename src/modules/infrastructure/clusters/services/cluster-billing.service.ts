import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, IsNull, Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { NodeBillableIntervalEntity } from '../entities/node-billable-interval.entity';
import {
  VolumeBillableIntervalEntity,
  VolumeBillableKind,
} from '../entities/volume-billable-interval.entity';
import { ProviderFactory } from 'src/modules/providers/services/provider.factory';
import { HetznerProviderService } from 'src/modules/providers/services/hetzner-provider.service';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { NodeSizeDto } from 'src/modules/providers/dto/node-size.dto';
import {
  ClusterBillingResponseDto,
  NodeMonthToDateDto,
  VolumeMonthToDateDto,
  RunRateDto,
  BillingPeriodDto,
  BillingBreakdownDto,
  TrafficInfoDto,
} from '../dto/cluster-billing.dto';

interface ServerTypePricing {
  priceHourlyGross: string;
  priceHourlyNet: string;
  priceMonthlyGross: string;
  priceMonthlyNet: string;
}

type ServerTypePricingMap = Map<string, Map<string, ServerTypePricing>>;

const CACHE_TTL_MS = 15 * 60 * 1000;
const BYTES_PER_TB = 1_000_000_000_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const HOURS_PER_MONTH = 730;

// €/GB·month for Flui-managed block storage. Hetzner: €0.044 gross; Scaleway
// SBS 5k IOPS: €0.05 gross. Net values are gross / 1.19 (Hetzner VAT) and
// gross / 1.20 (Scaleway VAT) — net used only when net VAT is requested.
const VOLUME_RATES_PER_GB_MONTH: Record<
  string,
  { gross: number; net: number }
> = {
  [CloudProvider.HETZNER]: { gross: 0.044, net: 0.044 / 1.19 },
  [CloudProvider.SCALEWAY]: { gross: 0.05, net: 0.05 / 1.2 },
};

@Injectable()
export class ClusterBillingService {
  private readonly logger = new Logger(ClusterBillingService.name);
  private pricingCache: {
    data: ServerTypePricingMap;
    fetchedAt: number;
    provider: CloudProvider;
  } | null = null;

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(NodeBillableIntervalEntity)
    private readonly nodeIntervalRepo: Repository<NodeBillableIntervalEntity>,
    @InjectRepository(VolumeBillableIntervalEntity)
    private readonly volumeIntervalRepo: Repository<VolumeBillableIntervalEntity>,
    private readonly providerFactory: ProviderFactory,
  ) {}

  async getClusterBilling(
    clusterId: string,
  ): Promise<ClusterBillingResponseDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const now = new Date();
    const billingPeriod = this.computeBillingPeriod(now);

    // BYOS (and any provider Flui doesn't price): no provider pricing API — you
    // pay your own infra provider, Flui bills nothing — so report zeros, not 500.
    if (!this.providerHasPricing(cluster.provider)) {
      return this.zeroBilling(cluster, billingPeriod, now);
    }

    const providerEnum = cluster.provider as CloudProvider;
    const provider = this.providerFactory.getProvider(providerEnum);
    const pricingMap = await this.getServerTypePricing(providerEnum, provider);

    const [nodeMtd, volumeMtd, runRate, traffic] = await Promise.all([
      this.computeNodeMonthToDate(cluster, pricingMap, billingPeriod, now),
      this.computeVolumeMonthToDate(cluster, billingPeriod, now),
      this.computeRunRate(cluster, pricingMap),
      this.computeTraffic(cluster, provider, pricingMap),
    ]);

    const mtdComputeGross = nodeMtd.reduce(
      (sum, n) => sum + Number.parseFloat(n.costGross),
      0,
    );
    const mtdComputeNet = nodeMtd.reduce(
      (sum, n) => sum + Number.parseFloat(n.costNet),
      0,
    );
    const mtdStorageGross = volumeMtd.reduce(
      (sum, v) => sum + Number.parseFloat(v.costGross),
      0,
    );
    const mtdStorageNet = volumeMtd.reduce(
      (sum, v) => sum + Number.parseFloat(v.costNet),
      0,
    );
    const mtdTrafficGross = Number.parseFloat(traffic.overageCostGross);
    const mtdTrafficNet = Number.parseFloat(traffic.overageCostNet);

    const monthToDateBreakdown: BillingBreakdownDto = {
      computeGross: mtdComputeGross.toFixed(4),
      computeNet: mtdComputeNet.toFixed(4),
      storageGross: mtdStorageGross.toFixed(4),
      storageNet: mtdStorageNet.toFixed(4),
      trafficGross: mtdTrafficGross.toFixed(4),
      trafficNet: mtdTrafficNet.toFixed(4),
    };

    return {
      clusterId: cluster.id,
      clusterName: cluster.name,
      provider: cluster.provider,
      region: cluster.region,
      currency: 'EUR',
      billingPeriod,
      monthToDate: {
        totalGross: (
          mtdComputeGross +
          mtdStorageGross +
          mtdTrafficGross
        ).toFixed(4),
        totalNet: (mtdComputeNet + mtdStorageNet + mtdTrafficNet).toFixed(4),
        breakdown: monthToDateBreakdown,
        nodes: nodeMtd,
        volumes: volumeMtd,
        traffic,
      },
      runRate,
      calculatedAt: now,
    };
  }

  // ─── Compute (nodes) ───────────────────────────────────────────────────────

  private async computeNodeMonthToDate(
    cluster: ClusterEntity,
    pricingMap: ServerTypePricingMap,
    period: BillingPeriodDto,
    now: Date,
  ): Promise<NodeMonthToDateDto[]> {
    const periodStart = new Date(period.start);
    const periodEnd = now;

    const intervals = await this.nodeIntervalRepo.find({
      where: [
        {
          clusterId: cluster.id,
          startedAt: LessThanOrEqual(periodEnd),
          endedAt: IsNull(),
        },
        {
          clusterId: cluster.id,
          startedAt: LessThanOrEqual(periodEnd),
          endedAt: MoreThanOrEqual(periodStart),
        },
      ],
      order: { startedAt: 'ASC' },
    });

    const byNode = new Map<string, NodeMonthToDateDto>();
    for (const iv of intervals) {
      const from = new Date(
        Math.max(iv.startedAt.getTime(), periodStart.getTime()),
      );
      const to = iv.endedAt
        ? new Date(Math.min(iv.endedAt.getTime(), periodEnd.getTime()))
        : periodEnd;
      const hours = Math.max(
        0,
        Math.ceil((to.getTime() - from.getTime()) / MS_PER_HOUR),
      );
      if (hours === 0) continue;

      const pricing = this.resolveLocationPricing(
        pricingMap,
        iv.serverType,
        cluster.region,
        iv.location,
      );
      if (!pricing) {
        this.logger.warn(
          `No pricing for type=${iv.serverType} region=${cluster.region} — interval ${iv.id} skipped`,
        );
        continue;
      }

      const hourlyGross = Number.parseFloat(pricing.priceHourlyGross);
      const hourlyNet = Number.parseFloat(pricing.priceHourlyNet);
      const monthlyGross = Number.parseFloat(pricing.priceMonthlyGross);
      const monthlyNet = Number.parseFloat(pricing.priceMonthlyNet);
      const segmentGross = Math.min(hours * hourlyGross, monthlyGross);
      const segmentNet = Math.min(hours * hourlyNet, monthlyNet);

      const existing = byNode.get(iv.nodeId);
      if (existing) {
        existing.billableHours += hours;
        existing.costGross = (
          Number.parseFloat(existing.costGross) + segmentGross
        ).toFixed(4);
        existing.costNet = (
          Number.parseFloat(existing.costNet) + segmentNet
        ).toFixed(4);
        existing.segments.push({
          serverType: iv.serverType,
          startedAt: iv.startedAt.toISOString(),
          endedAt: iv.endedAt ? iv.endedAt.toISOString() : null,
          hours,
          costGross: segmentGross.toFixed(4),
          costNet: segmentNet.toFixed(4),
        });
      } else {
        byNode.set(iv.nodeId, {
          nodeId: iv.nodeId,
          serverName: iv.serverName,
          nodeType: iv.nodeType,
          currentServerType: iv.serverType,
          providerResourceId: iv.providerResourceId ?? null,
          status: iv.endedAt ? 'terminated' : 'active',
          billableHours: hours,
          costGross: segmentGross.toFixed(4),
          costNet: segmentNet.toFixed(4),
          segments: [
            {
              serverType: iv.serverType,
              startedAt: iv.startedAt.toISOString(),
              endedAt: iv.endedAt ? iv.endedAt.toISOString() : null,
              hours,
              costGross: segmentGross.toFixed(4),
              costNet: segmentNet.toFixed(4),
            },
          ],
        });
      }
    }

    return [...byNode.values()];
  }

  // ─── Compute (volumes) ─────────────────────────────────────────────────────

  private async computeVolumeMonthToDate(
    cluster: ClusterEntity,
    period: BillingPeriodDto,
    now: Date,
  ): Promise<VolumeMonthToDateDto[]> {
    const periodStart = new Date(period.start);
    const periodEnd = now;

    const intervals = await this.volumeIntervalRepo.find({
      where: [
        {
          clusterId: cluster.id,
          startedAt: LessThanOrEqual(periodEnd),
          endedAt: IsNull(),
        },
        {
          clusterId: cluster.id,
          startedAt: LessThanOrEqual(periodEnd),
          endedAt: MoreThanOrEqual(periodStart),
        },
      ],
      order: { startedAt: 'ASC' },
    });

    const rates = VOLUME_RATES_PER_GB_MONTH[cluster.provider];
    if (!rates) return [];

    const byVolume = new Map<string, VolumeMonthToDateDto>();
    for (const iv of intervals) {
      const from = new Date(
        Math.max(iv.startedAt.getTime(), periodStart.getTime()),
      );
      const to = iv.endedAt
        ? new Date(Math.min(iv.endedAt.getTime(), periodEnd.getTime()))
        : periodEnd;
      const days = Math.max(0, (to.getTime() - from.getTime()) / MS_PER_DAY);
      if (days === 0) continue;

      const totalDaysInMonth = period.totalHours / 24;
      const fraction = days / totalDaysInMonth;
      const segmentGross = fraction * iv.sizeGb * rates.gross;
      const segmentNet = fraction * iv.sizeGb * rates.net;

      const key = iv.volumeProviderId;
      const existing = byVolume.get(key);
      if (existing) {
        existing.costGross = (
          Number.parseFloat(existing.costGross) + segmentGross
        ).toFixed(4);
        existing.costNet = (
          Number.parseFloat(existing.costNet) + segmentNet
        ).toFixed(4);
      } else {
        byVolume.set(key, {
          volumeProviderId: iv.volumeProviderId,
          kind: iv.kind,
          currentSizeGb: iv.sizeGb,
          status: iv.endedAt ? 'terminated' : 'active',
          costGross: segmentGross.toFixed(4),
          costNet: segmentNet.toFixed(4),
        });
      }
    }

    return [...byVolume.values()];
  }

  // ─── Run rate (current config × full month) ────────────────────────────────

  private async computeRunRate(
    cluster: ClusterEntity,
    pricingMap: ServerTypePricingMap,
  ): Promise<RunRateDto> {
    const openNodes = await this.nodeIntervalRepo.find({
      where: { clusterId: cluster.id, endedAt: IsNull() },
    });
    const openVolumes = await this.volumeIntervalRepo.find({
      where: { clusterId: cluster.id, endedAt: IsNull() },
    });

    let computeGross = 0;
    let computeNet = 0;
    for (const node of openNodes) {
      const pricing = this.resolveLocationPricing(
        pricingMap,
        node.serverType,
        cluster.region,
        node.location,
      );
      if (!pricing) continue;
      computeGross += Number.parseFloat(pricing.priceMonthlyGross);
      computeNet += Number.parseFloat(pricing.priceMonthlyNet);
    }

    const rates = VOLUME_RATES_PER_GB_MONTH[cluster.provider];
    let storageGross = 0;
    let storageNet = 0;
    if (rates) {
      for (const v of openVolumes) {
        storageGross += v.sizeGb * rates.gross;
        storageNet += v.sizeGb * rates.net;
      }
    }

    return {
      monthlyGross: (computeGross + storageGross).toFixed(2),
      monthlyNet: (computeNet + storageNet).toFixed(2),
      breakdown: {
        computeGross: computeGross.toFixed(2),
        computeNet: computeNet.toFixed(2),
        storageGross: storageGross.toFixed(2),
        storageNet: storageNet.toFixed(2),
        trafficGross: '0.00',
        trafficNet: '0.00',
      },
      activeNodes: openNodes.length,
      activeVolumes: openVolumes.length,
    };
  }

  // ─── Traffic (Hetzner only, current snapshot) ──────────────────────────────

  private async computeTraffic(
    cluster: ClusterEntity,
    provider: unknown,
    pricingMap: ServerTypePricingMap,
  ): Promise<TrafficInfoDto> {
    if (cluster.provider !== CloudProvider.HETZNER) {
      return this.zeroTraffic();
    }
    const hetzner = provider as HetznerProviderService;
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
    void pricingMap;
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

  private providerHasPricing(provider: string): boolean {
    const supported = this.providerFactory.getSupportedProviders() as string[];
    return supported.includes(provider);
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

  private async getServerTypePricing(
    providerEnum: CloudProvider,
    provider: {
      getNodeSizes?: (includeAvailability?: boolean) => Promise<NodeSizeDto[]>;
    },
  ): Promise<ServerTypePricingMap> {
    const now = Date.now();
    if (
      this.pricingCache?.provider === providerEnum &&
      now - this.pricingCache.fetchedAt < CACHE_TTL_MS
    ) {
      return this.pricingCache.data;
    }
    if (!provider.getNodeSizes) {
      throw new Error(
        `Provider ${providerEnum} does not implement getNodeSizes`,
      );
    }
    const sizes = await provider.getNodeSizes();
    const pricingMap: ServerTypePricingMap = new Map();
    for (const size of sizes) {
      const locationMap = new Map<string, ServerTypePricing>();
      for (const price of size.prices ?? []) {
        locationMap.set(price.location, {
          priceHourlyGross: price.priceHourly?.gross ?? '0',
          priceHourlyNet: price.priceHourly?.net ?? '0',
          priceMonthlyGross: price.priceMonthly?.gross ?? '0',
          priceMonthlyNet: price.priceMonthly?.net ?? '0',
        });
      }
      pricingMap.set(size.name, locationMap);
    }
    this.pricingCache = {
      data: pricingMap,
      fetchedAt: now,
      provider: providerEnum,
    };
    return pricingMap;
  }

  private resolveLocationPricing(
    pricingMap: ServerTypePricingMap,
    serverTypeName: string,
    region: string,
    location?: string | null,
  ): ServerTypePricing | null {
    const typeMap = pricingMap.get(serverTypeName);
    if (!typeMap) return null;
    return (
      typeMap.get(region) ??
      (location ? (typeMap.get(location) ?? null) : null) ??
      typeMap.values().next().value ??
      null
    );
  }
}

void BYTES_PER_TB;
void HOURS_PER_MONTH;
void VolumeBillableKind;
