export type FleetWindow = '1h' | '3h' | '24h';

export const FLEET_WINDOWS: Record<
  FleetWindow,
  { seconds: number; step: string; stepSeconds: number }
> = {
  '1h': { seconds: 3_600, step: '30s', stepSeconds: 30 },
  '3h': { seconds: 10_800, step: '1m', stepSeconds: 60 },
  '24h': { seconds: 86_400, step: '5m', stepSeconds: 300 },
};

/** Samples older than this many steps no longer describe the present, as on the cluster Monitoring page. */
export const STALE_AFTER_STEPS = 3;

export interface NodeDataPoint {
  timestamp: number;
  cpu_percent?: number;
  memory_percent?: number;
  disk_percent?: number;
  network_in?: number;
  network_out?: number;
}

export interface NodeHistory {
  server_id?: string;
  data_points: NodeDataPoint[];
}

export interface FleetPoint {
  timestamp: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  networkInBytesPerSecond: number | null;
  networkOutBytesPerSecond: number | null;
  nodes: number;
}

export type ClusterMetricsState =
  | 'reporting'
  | 'stale'
  | 'no_data'
  | 'unavailable';

const round = (v: number) => Math.round(v * 100) / 100;

interface Bucket {
  cpu: number[];
  memory: number[];
  disk: number[];
  inBytes: number | null;
  outBytes: number | null;
  nodes: Set<string>;
}

const isNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const mean = (values: number[]) =>
  values.length
    ? round(values.reduce((s, v) => s + v, 0) / values.length)
    : null;

/**
 * The same arithmetic the cluster Monitoring page draws: percentages are the
 * average over the nodes that reported at that instant, network is the sum of
 * every node's traffic. A missing reading stays missing, never a zero.
 */
export function aggregateNodes(nodes: NodeHistory[]): FleetPoint[] {
  const buckets = new Map<number, Bucket>();
  nodes.forEach((node, index) => {
    const key = node.server_id ?? String(index);
    for (const p of node.data_points) {
      const b = buckets.get(p.timestamp) ?? {
        cpu: [],
        memory: [],
        disk: [],
        inBytes: null,
        outBytes: null,
        nodes: new Set<string>(),
      };
      let seen = false;
      if (isNumber(p.cpu_percent)) {
        b.cpu.push(p.cpu_percent);
        seen = true;
      }
      if (isNumber(p.memory_percent)) {
        b.memory.push(p.memory_percent);
        seen = true;
      }
      if (isNumber(p.disk_percent)) {
        b.disk.push(p.disk_percent);
        seen = true;
      }
      if (isNumber(p.network_in)) {
        b.inBytes = (b.inBytes ?? 0) + p.network_in;
        seen = true;
      }
      if (isNumber(p.network_out)) {
        b.outBytes = (b.outBytes ?? 0) + p.network_out;
        seen = true;
      }
      if (seen) b.nodes.add(key);
      buckets.set(p.timestamp, b);
    }
  });

  return [...buckets.entries()]
    .filter(([, b]) => b.nodes.size > 0)
    .sort(([a], [b]) => a - b)
    .map(([ts, b]) => ({
      timestamp: new Date(ts * 1000).toISOString(),
      cpuPercent: mean(b.cpu),
      memoryPercent: mean(b.memory),
      diskPercent: mean(b.disk),
      networkInBytesPerSecond: b.inBytes === null ? null : round(b.inBytes),
      networkOutBytesPerSecond: b.outBytes === null ? null : round(b.outBytes),
      nodes: b.nodes.size,
    }));
}

export function stateOf(
  series: FleetPoint[],
  end: Date,
  stepSeconds: number,
): ClusterMetricsState {
  const last = series.at(-1);
  if (!last) return 'no_data';
  const age = end.getTime() - Date.parse(last.timestamp);
  return age <= stepSeconds * STALE_AFTER_STEPS * 1000 ? 'reporting' : 'stale';
}
