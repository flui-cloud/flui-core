/**
 * The example cluster's machines, and the fleet over time, for the scaling
 * group's page.
 *
 * The page reads them from the example cluster, which is the one cluster id the
 * fence admits besides the guest's own — and only on routes the example world
 * answers. The nodes route of the guest's own cluster still answers for real.
 */
import {
  CLUSTER_ID,
  daysAgo,
  mark,
  MACHINES,
  PROVIDER,
  REGION,
  SandboxStandInQuery,
} from './sandbox-world-core';
import {
  ExampleShape,
  fleetLifetimes,
  MACHINES_SINCE_DAYS,
  SERVER_PRICES,
} from './sandbox-world-fleet';

type Params = Record<string, string | undefined>;

const HOUR = 3_600_000;
const MAX_POINTS = 400;

export function exampleClusterNodes(now: number) {
  return MACHINES.map((m, index) =>
    mark({
      id: m.id,
      serverName: m.name,
      nodeType: m.role,
      ipAddress: m.privateIp,
      status: 'ready',
      providerResourceId: `example-${index + 1}`,
      provider: PROVIDER,
      region: REGION,
      serverType: SERVER_PRICES[m.productName as ExampleShape].serverType,
      hourlyPriceEur: SERVER_PRICES[m.productName as ExampleShape].hourlyNet,
      // On a cluster with workers the master is kept for the platform.
      takesNewApps: m.role !== 'master',
      createdAt: daysAgo(now, MACHINES_SINCE_DAYS),
      metadata: {},
    }),
  );
}

const MEMORY_MI: Record<ExampleShape, number> = {
  CPX31: 7600,
  CPX41: 15_800,
};
const CPU_MILLICORES: Record<ExampleShape, number> = {
  CPX31: 3800,
  CPX41: 7800,
};

/** The window the page asked for, the way the real route reads it. */
function windowOf(now: number, q: SandboxStandInQuery) {
  const n = (key: string) => {
    const raw = q[key];
    const value =
      typeof raw === 'string' || typeof raw === 'number'
        ? Number.parseFloat(String(raw))
        : Number.NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const from = typeof q.from === 'string' ? Date.parse(q.from) : Number.NaN;
  const to = typeof q.to === 'string' ? Date.parse(q.to) : Number.NaN;
  const end = Number.isNaN(to) ? now : Math.min(to, now);
  const start = !Number.isNaN(from)
    ? from
    : end - (n('hours') ?? (n('days') ?? 30) * 24) * HOUR;
  const asked =
    n('stepMinutes') !== null
      ? (n('stepMinutes') as number) * 60_000
      : (n('stepHours') ?? 24) * HOUR;
  const step = Math.max(asked, Math.ceil((end - start) / MAX_POINTS));
  return { start, end, step };
}

/**
 * One point per step: the machines alive at that moment, what they cost an
 * hour, and how much of them the applications had reserved — a little more in
 * the day than at night, which is the whole shape of a small shop's traffic.
 */
export function exampleFleetHistory(
  now: number,
  query?: SandboxStandInQuery,
  params?: Params,
) {
  const { start, end, step } = windowOf(now, query ?? {});
  const lives = fleetLifetimes(now);
  const points = [];
  for (let at = start; at <= end; at += step) {
    const alive = lives.filter(
      (l) => l.startedAt <= at && (l.endedAt === null || l.endedAt > at),
    );
    const byShape: Record<string, number> = {};
    let hourly = 0;
    let memory = 0;
    let cpu = 0;
    for (const life of alive) {
      const type = SERVER_PRICES[life.shape].serverType;
      byShape[type] = (byShape[type] ?? 0) + 1;
      hourly += SERVER_PRICES[life.shape].hourlyNet;
      memory += MEMORY_MI[life.shape];
      cpu += CPU_MILLICORES[life.shape];
    }
    const hourOfDay = new Date(at).getUTCHours();
    const daytime = 0.5 + 0.5 * Math.sin(((hourOfDay - 9) / 24) * 2 * Math.PI);
    points.push({
      at: new Date(at).toISOString(),
      byShape,
      nodes: alive.length,
      hourlyEur: Number(hourly.toFixed(6)),
      unpricedNodes: 0,
      load: alive.length
        ? {
            reservedMemoryMi: Math.round(17_300 + 3000 * daytime),
            capacityMemoryMi: memory,
            reservedCpuMillicores: Math.round(7550 + 1800 * daytime),
            capacityCpuMillicores: cpu,
          }
        : null,
    });
  }
  return mark({
    clusterId: params?.id ?? params?.clusterId ?? CLUSTER_ID,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    stepSeconds: Math.round(step / 1000),
    points,
    orphanedIntervals: 0,
    orphanedOpenIntervals: 0,
    message: null,
  });
}
