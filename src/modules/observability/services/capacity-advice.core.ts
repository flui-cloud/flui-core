export const CAPACITY_ADVICE = [
  'none',
  'add_replicas',
  'add_node',
  'wait_for_node',
  'raise_autoscale_max',
  'autoscaler_adding',
  'one_copy_only',
  'watch_memory',
  'unknown',
] as const;
export type CapacityAdvice = (typeof CAPACITY_ADVICE)[number];

export interface CapacityThresholds {
  windowMinutes: number;
  throttledPercent: number;
  cpuPercent: number;
  memoryPercent: number;
  readinessFailures: number;
}

export const capacityThresholds = (
  env: NodeJS.ProcessEnv = process.env,
): CapacityThresholds => ({
  windowMinutes: Number(env.FLUI_ADVICE_WINDOW_MINUTES) || 15,
  throttledPercent: Number(env.FLUI_ADVICE_THROTTLED_PERCENT) || 40,
  cpuPercent: Number(env.FLUI_ADVICE_CPU_PERCENT) || 90,
  memoryPercent: Number(env.FLUI_ADVICE_MEMORY_PERCENT) || 90,
  readinessFailures: Number(env.FLUI_ADVICE_READINESS_FAILURES) || 3,
});

export interface CapacityMeasures {
  /**
   * Median, over the window's minutes, of the share of time the copies were
   * held back by their CPU limit: a copy starting up is held back for a
   * minute or two, and must not read as a busy one.
   */
  throttledPercent: number | null;
  /** Median of the per-minute CPU peaks, as a share of the limit. */
  cpuPercent: number | null;
  /** Highest memory use in the window, as a share of the limit. */
  memoryPercent: number | null;
  readinessFailures: number | null;
  restartsByLiveness: number | null;
}

export interface CapacityInput {
  kind: string;
  desired: number;
  ready: number;
  autoscaling: { enabled: boolean; max: number };
  waitingForNode: { replicas: number; says: string } | null;
  nextCopy: { verdict: string; sentence: string } | null;
  /**
   * The next copy would be placed by the cluster today, but only in the
   * margin Flui keeps free on each node: nothing would be bought for it.
   */
  fitsInMargin?: boolean;
  measures: CapacityMeasures;
}

export interface CapacityVerdict {
  advice: CapacityAdvice;
  sentence: string;
  reasons: string[];
}

const pct = (value: number) => `${Math.round(value)}%`;
const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

const copiesOf = (n: number) =>
  n === 1 ? 'A copy is' : String(n) + ' copies are';
const keepersOf = (n: number) =>
  n === 1 ? 'copy keeps' : String(n) + ' copies keep';

/** What crossed a threshold: the saturation reasons, then memory apart. */
function reasonsFor(
  m: CapacityMeasures,
  limits: CapacityThresholds,
): { reasons: string[]; busy: boolean; memoryHigh: boolean } {
  const reasons: string[] = [];
  if (
    m.throttledPercent !== null &&
    m.throttledPercent >= limits.throttledPercent
  ) {
    reasons.push(
      `held back by its CPU limit ${pct(m.throttledPercent)} of the time`,
    );
  }
  if (m.cpuPercent !== null && m.cpuPercent >= limits.cpuPercent) {
    reasons.push(`CPU at ${pct(m.cpuPercent)} of its limit`);
  }
  if (
    m.readinessFailures !== null &&
    m.readinessFailures >= limits.readinessFailures
  ) {
    reasons.push(
      `too busy to answer its readiness check ${times(m.readinessFailures)} in the last hour`,
    );
  }
  if (m.restartsByLiveness) {
    reasons.push(
      `restarted ${times(m.restartsByLiveness)} by its liveness check in the last hour`,
    );
  }
  const busy = reasons.length > 0;
  const memoryHigh =
    m.memoryPercent !== null && m.memoryPercent >= limits.memoryPercent;
  if (memoryHigh)
    reasons.push(`memory at ${pct(m.memoryPercent as number)} of its limit`);
  return { reasons, busy, memoryHigh };
}

/** The answer for copies that are saturated and could be joined by another. */
function moreCopies(input: CapacityInput, reasons: string[]): CapacityVerdict {
  if (input.kind === 'StatefulSet') {
    return {
      advice: 'one_copy_only',
      sentence:
        'It keeps data on each copy, so another copy would not share the load: give it more CPU or memory.',
      reasons,
    };
  }
  if (input.autoscaling.enabled) {
    const atMax = input.desired >= input.autoscaling.max;
    return {
      advice: atMax ? 'raise_autoscale_max' : 'autoscaler_adding',
      sentence: atMax
        ? `The autoscaler is already at its maximum of ${input.autoscaling.max} copies: raise the maximum.`
        : `The autoscaler can still add copies, up to ${input.autoscaling.max}.`,
      reasons,
    };
  }
  const next = input.desired + 1;
  if (input.fitsInMargin) {
    return {
      advice: 'add_replicas',
      sentence: `Run ${next} copies: there is room, in the margin kept free on each node.`,
      reasons,
    };
  }
  const verdict = input.nextCopy?.verdict;
  if (verdict === 'proposes' || verdict === 'nothing-hosts') {
    return {
      advice: 'add_node',
      sentence: 'Another copy has nowhere to run: add a node first.',
      reasons,
    };
  }
  return {
    advice: 'add_replicas',
    sentence:
      verdict === 'buys'
        ? `Run ${next} copies: the scaling group buys a node for the new one.`
        : `Run ${next} copies: there is room for another one.`,
    reasons,
  };
}

/**
 * Whether an application needs more copies, a node to put them on, or
 * neither. Copies are the lever: a copy that is saturated is answered with
 * another copy, and with a node only when the next copy has nowhere to go.
 */
export function adviseCapacity(
  input: CapacityInput,
  limits: CapacityThresholds,
): CapacityVerdict {
  const { reasons, busy, memoryHigh } = reasonsFor(input.measures, limits);

  if (input.waitingForNode) {
    return {
      advice: 'wait_for_node',
      sentence: `${copiesOf(input.waitingForNode.replicas)} waiting for a node.`,
      reasons: [input.waitingForNode.says, ...reasons],
    };
  }
  if (!Object.values(input.measures).some((value) => value !== null)) {
    return {
      advice: 'unknown',
      sentence:
        'Nothing was measured in the window, so there is nothing to judge yet.',
      reasons,
    };
  }
  if (busy) return moreCopies(input, reasons);
  if (memoryHigh) {
    return {
      advice: 'watch_memory',
      sentence:
        'Memory is close to its limit: add a copy if it grows with traffic, raise the limit if not.',
      reasons,
    };
  }
  return {
    advice: 'none',
    sentence: `The ${keepersOf(input.ready)} up with the load.`,
    reasons,
  };
}

const medianOf = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function measuresFrom(
  points: Array<{
    cpu_throttled_percent?: number;
    cpu_utilization_percent?: number;
    memory_utilization_percent?: number;
  }>,
  checks: { readinessBusy: number; restartsByLiveness: number; read: boolean },
): CapacityMeasures {
  const series = (key: keyof (typeof points)[number]) =>
    points
      .map((point) => point[key])
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value),
      );
  const memory = series('memory_utilization_percent');
  return {
    throttledPercent: medianOf(series('cpu_throttled_percent')),
    cpuPercent: medianOf(series('cpu_utilization_percent')),
    memoryPercent: memory.length ? Math.max(...memory) : null,
    readinessFailures: checks.read ? checks.readinessBusy : null,
    restartsByLiveness: checks.read ? checks.restartsByLiveness : null,
  };
}

export interface NodeFit {
  takesWork: boolean;
  allocatable: { cpuMillicores: number; memoryMi: number };
  requested: { cpuMillicores: number; memoryMi: number };
}

/** Whether the cluster itself would place a copy of this size, margin included. */
export function placedByCluster(
  nodes: NodeFit[],
  ask: { cpuMillicores: number; memoryMi: number },
): boolean {
  return nodes.some(
    (node) =>
      node.takesWork &&
      node.allocatable.cpuMillicores - node.requested.cpuMillicores >=
        ask.cpuMillicores &&
      node.allocatable.memoryMi - node.requested.memoryMi >= ask.memoryMi,
  );
}
