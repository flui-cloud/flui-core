import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';
import { NodeBillableIntervalEntity } from '../entities/node-billable-interval.entity';
import { VolumeBillableIntervalEntity } from '../entities/volume-billable-interval.entity';
import { CostsResponseDto } from '../dto/costs.dto';
import { monthsBack } from '../costs/cost-accrual';
import {
  LedgerCluster,
  LedgerProvider,
  RatedLifetime,
  buildLedger,
} from '../costs/cost-ledger';
import { billingOf } from '../costs/provider-billing';
import {
  CostRatesService,
  StampedNodePrice,
  StampedVolumePrice,
} from './cost-rates.service';

export const DEFAULT_COST_MONTHS = 6;
export const MAX_COST_MONTHS = 24;

export const COST_NOTES = [
  'Costs are the machines and volumes of your clusters; applications cost nothing on their own.',
  'Traffic above what each machine includes is not counted.',
  'The forecast assumes what runs now keeps running until the end of the month.',
];

@Injectable()
export class CostsService {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(NodeBillableIntervalEntity)
    private readonly nodeIntervals: Repository<NodeBillableIntervalEntity>,
    @InjectRepository(VolumeBillableIntervalEntity)
    private readonly volumeIntervals: Repository<VolumeBillableIntervalEntity>,
    private readonly rates: CostRatesService,
  ) {}

  async getCosts(
    options: { months?: number } = {},
    now = new Date(),
  ): Promise<CostsResponseDto> {
    const count = Math.min(
      Math.max(Math.trunc(options.months ?? DEFAULT_COST_MONTHS) || 1, 1),
      MAX_COST_MONTHS,
    );
    const months = monthsBack(now, count);
    const from = months[0].start;

    const [nodes, volumes] = await Promise.all([
      this.nodeIntervals
        .createQueryBuilder('interval')
        .where('interval.startedAt <= :now', { now })
        .andWhere('(interval.endedAt IS NULL OR interval.endedAt >= :from)', {
          from,
        })
        .getMany(),
      this.volumeIntervals
        .createQueryBuilder('interval')
        .where('interval.startedAt <= :now', { now })
        .andWhere('(interval.endedAt IS NULL OR interval.endedAt >= :from)', {
          from,
        })
        .getMany(),
    ]);

    const lifetimes: RatedLifetime[] = [];
    for (const row of nodes) {
      const rate = this.rates.isPriced(row.provider)
        ? await this.rates.nodeRate(
            row.provider,
            row.serverType,
            row.region,
            row.location,
            row.metadata?.price as StampedNodePrice | undefined,
          )
        : null;
      lifetimes.push({
        kind: 'node',
        provider: row.provider,
        clusterId: row.clusterId,
        startedAt: row.startedAt,
        endedAt: row.endedAt ?? null,
        nodeRate: rate,
        basis: rate?.basis ?? null,
      });
    }
    for (const row of volumes) {
      const stamped = row.metadata?.price as StampedVolumePrice | undefined;
      const rate = this.rates.isPriced(row.provider)
        ? await this.rates.volumeRate(row.provider, stamped)
        : null;
      lifetimes.push({
        kind: 'volume',
        provider: row.provider,
        clusterId: row.clusterId,
        startedAt: row.startedAt,
        endedAt: row.endedAt ?? null,
        sizeGb: row.sizeGb,
        volumeRate: rate,
        basis: volumeBasis(rate !== null, stamped),
      });
    }

    const ledger = buildLedger(
      lifetimes,
      await this.clusters(nodes, volumes),
      await this.providers(lifetimes),
      months,
      now,
    );

    return {
      currency: 'EUR',
      months: ledger.months,
      totals: ledger.totals,
      providers: ledger.providers,
      recordedSince: ledger.recordedSince,
      notes: COST_NOTES,
      calculatedAt: now,
    };
  }

  private async clusters(
    nodes: NodeBillableIntervalEntity[],
    volumes: VolumeBillableIntervalEntity[],
  ): Promise<Map<string, LedgerCluster>> {
    const ids = [...new Set([...nodes, ...volumes].map((r) => r.clusterId))];
    const rows = ids.length
      ? await this.clusterRepository.find({ where: { id: In(ids) } })
      : [];
    const out = new Map<string, LedgerCluster>();
    for (const row of rows) {
      const removed =
        row.status === ClusterStatus.DELETED || row.deletedAt != null;
      out.set(row.id, {
        name: row.name,
        region: row.region ?? null,
        removed,
        removedAt: removed ? (row.deletedAt ?? row.updatedAt ?? null) : null,
      });
    }
    for (const interval of [...nodes, ...volumes]) {
      const recordedName = interval.metadata?.clusterName;
      if (out.has(interval.clusterId) || typeof recordedName !== 'string') {
        continue;
      }
      out.set(interval.clusterId, {
        name: recordedName,
        region: interval.region ?? null,
        removed: true,
      });
    }
    return out;
  }

  private async providers(
    lifetimes: RatedLifetime[],
  ): Promise<Map<string, LedgerProvider>> {
    const out = new Map<string, LedgerProvider>();
    for (const provider of new Set(lifetimes.map((l) => l.provider))) {
      const priced = this.rates.isPriced(provider);
      const vat = priced
        ? await this.rates.vat(provider)
        : { included: false, ratePercent: null };
      out.set(provider, {
        billing: priced ? billingOf(provider) : null,
        vatIncluded: vat.included,
        vatRatePercent: vat.ratePercent,
      });
    }
    return out;
  }
}

function volumeBasis(
  priced: boolean,
  stamped: StampedVolumePrice | undefined,
): RatedLifetime['basis'] {
  if (!priced) return null;
  return stamped ? (stamped.basis ?? 'recorded') : 'list';
}
