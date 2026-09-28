import {
  Amount,
  CalendarMonth,
  MonthAccrual,
  NodeRate,
  PriceBasis,
  VolumeRate,
  ZERO,
  accrueNode,
  accrueVolume,
  addAmount,
  roundAmount,
} from './cost-accrual';
import { ProviderBilling } from './provider-billing';

export interface RatedLifetime {
  kind: 'node' | 'volume';
  provider: string;
  clusterId: string;
  startedAt: Date;
  endedAt: Date | null;
  sizeGb?: number;
  nodeRate?: NodeRate | null;
  volumeRate?: VolumeRate | null;
  /** Null when the lifetime has no price at all. */
  basis: PriceBasis | null;
}

export interface LedgerCluster {
  name: string;
  region: string | null;
  removed: boolean;
}

export interface LedgerProvider {
  billing: ProviderBilling | null;
  vatIncluded: boolean;
  vatRatePercent: string | null;
}

export interface LedgerMonth {
  month: string;
  current: boolean;
  spentNet: number;
  spentGross: number | null;
  forecastNet: number | null;
  forecastGross: number | null;
}

export interface LedgerClusterRow {
  clusterId: string;
  clusterName: string;
  region: string | null;
  removed: boolean;
  months: LedgerMonth[];
  unpriced: number;
  listPriced: number;
}

export interface LedgerProviderRow {
  provider: string;
  priced: boolean;
  billedAs: string | null;
  vatIncluded: boolean;
  vatRatePercent: string | null;
  months: LedgerMonth[];
  clusters: LedgerClusterRow[];
  unpriced: number;
  listPriced: number;
  note: string | null;
}

export interface Ledger {
  months: string[];
  totals: LedgerMonth[];
  providers: LedgerProviderRow[];
  recordedSince: Date | null;
}

interface Bucket {
  spent: Amount;
  forecast: Amount;
}

function emptyBuckets(months: CalendarMonth[]): Bucket[] {
  return months.map(() => ({ spent: { ...ZERO }, forecast: { ...ZERO } }));
}

function toMonths(
  buckets: Bucket[],
  months: CalendarMonth[],
  now: Date,
  grossKnown: boolean,
): LedgerMonth[] {
  return buckets.map((bucket, i) => {
    const current = months[i].start <= now && now < months[i].end;
    const spent = roundAmount(bucket.spent);
    const forecast = roundAmount(bucket.forecast);
    return {
      month: months[i].key,
      current,
      spentNet: spent.net,
      spentGross: grossKnown ? spent.gross : null,
      forecastNet: current ? forecast.net : null,
      forecastGross: current && grossKnown ? forecast.gross : null,
    };
  });
}

interface ClusterTally {
  buckets: Bucket[];
  unpriced: number;
  listPriced: number;
}

interface ProviderTally extends ClusterTally {
  clusters: Map<string, ClusterTally>;
}

function tally(
  byProvider: Map<string, ProviderTally>,
  lifetime: RatedLifetime,
  providers: Map<string, LedgerProvider>,
  months: CalendarMonth[],
  now: Date,
): void {
  let provider = byProvider.get(lifetime.provider);
  if (!provider) {
    provider = {
      buckets: emptyBuckets(months),
      clusters: new Map(),
      unpriced: 0,
      listPriced: 0,
    };
    byProvider.set(lifetime.provider, provider);
  }
  let cluster = provider.clusters.get(lifetime.clusterId);
  if (!cluster) {
    cluster = { buckets: emptyBuckets(months), unpriced: 0, listPriced: 0 };
    provider.clusters.set(lifetime.clusterId, cluster);
  }

  if (lifetime.basis === null) {
    cluster.unpriced++;
    provider.unpriced++;
    return;
  }
  if (lifetime.basis === 'list') {
    cluster.listPriced++;
    provider.listPriced++;
  }

  const caps =
    providers.get(lifetime.provider)?.billing?.capsAtMonthlyPrice ?? false;
  months.forEach((month, i) => {
    const accrual = accrualOf(lifetime, month, now, caps);
    if (!accrual) return;
    for (const bucket of [cluster.buckets[i], provider.buckets[i]]) {
      bucket.spent = addAmount(bucket.spent, accrual.spent);
      bucket.forecast = addAmount(bucket.forecast, accrual.forecast);
    }
  });
}

function clusterRows(
  tallies: Map<string, ClusterTally>,
  clusters: Map<string, LedgerCluster>,
  months: CalendarMonth[],
  now: Date,
  grossKnown: boolean,
): LedgerClusterRow[] {
  return [...tallies.entries()]
    .map(([clusterId, row]) => {
      const known = clusters.get(clusterId);
      return {
        clusterId,
        clusterName: known?.name ?? `Removed cluster ${clusterId.slice(0, 8)}`,
        region: known?.region ?? null,
        removed: known?.removed ?? true,
        months: toMonths(row.buckets, months, now, grossKnown),
        unpriced: row.unpriced,
        listPriced: row.listPriced,
      };
    })
    .sort(
      (a, b) =>
        Number(a.removed) - Number(b.removed) ||
        a.clusterName.localeCompare(b.clusterName),
    );
}

function accrualOf(
  lifetime: RatedLifetime,
  month: CalendarMonth,
  now: Date,
  capsAtMonthly: boolean,
): MonthAccrual | null {
  if (lifetime.kind === 'node') {
    return lifetime.nodeRate
      ? accrueNode(lifetime, lifetime.nodeRate, month, now, capsAtMonthly)
      : null;
  }
  return lifetime.volumeRate
    ? accrueVolume(
        lifetime,
        lifetime.sizeGb ?? 0,
        lifetime.volumeRate,
        month,
        now,
      )
    : null;
}

/**
 * Spent and forecast, month by month, provider by provider and cluster by
 * cluster, from the lifetimes Flui records. A lifetime with no price is
 * counted as unpriced rather than as free, and the figures it would have added
 * are simply absent — the page says how many.
 */
export function buildLedger(
  lifetimes: RatedLifetime[],
  clusters: Map<string, LedgerCluster>,
  providers: Map<string, LedgerProvider>,
  months: CalendarMonth[],
  now: Date,
): Ledger {
  const byProvider = new Map<string, ProviderTally>();
  let recordedSince: Date | null = null;

  for (const lifetime of lifetimes) {
    if (!recordedSince || lifetime.startedAt < recordedSince) {
      recordedSince = lifetime.startedAt;
    }
    tally(byProvider, lifetime, providers, months, now);
  }

  const totals = emptyBuckets(months);
  let everyGrossKnown = byProvider.size > 0;
  const rows: LedgerProviderRow[] = [];

  for (const [name, provider] of byProvider) {
    const info = providers.get(name);
    const priced = !!info?.billing;
    const grossKnown = priced && !!info?.vatIncluded;
    if (priced && !grossKnown) everyGrossKnown = false;
    if (priced) {
      provider.buckets.forEach((bucket, i) => {
        totals[i].spent = addAmount(totals[i].spent, bucket.spent);
        totals[i].forecast = addAmount(totals[i].forecast, bucket.forecast);
      });
    }

    rows.push({
      provider: name,
      priced,
      billedAs: info?.billing?.billedAs ?? null,
      vatIncluded: grossKnown,
      vatRatePercent: grossKnown ? (info?.vatRatePercent ?? null) : null,
      months: toMonths(provider.buckets, months, now, grossKnown),
      clusters: clusterRows(
        provider.clusters,
        clusters,
        months,
        now,
        grossKnown,
      ),
      unpriced: provider.unpriced,
      listPriced: provider.listPriced,
      note: priced
        ? null
        : 'Flui has no price list for this provider: the machines are counted, not priced. You pay it directly.',
    });
  }

  rows.sort(
    (a, b) =>
      Number(b.priced) - Number(a.priced) ||
      a.provider.localeCompare(b.provider),
  );

  return {
    months: months.map((m) => m.key),
    totals: toMonths(totals, months, now, everyGrossKnown),
    providers: rows,
    recordedSince,
  };
}
