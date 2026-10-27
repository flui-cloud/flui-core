/**
 * What the example scaling group decided, and why: the busy afternoon, the
 * quiet night, and the "nothing to do" it has said every few minutes since.
 * The same history in the group's page and on the cluster's Scaling tab.
 */
import {
  CLUSTER_ID,
  hoursAgo,
  MACHINES,
  mark,
  REGION,
  SandboxStandInQuery,
} from './sandbox-world-core';
import { WORLD_SERVERS, worldRequested } from './sandbox-world-topology-data';
import { BURST_WORKER, SERVER_PRICES } from './sandbox-world-fleet';
import {
  BOUNDS,
  CEILING_EUR,
  isExampleGroup,
  LAST_LOOK_HOURS,
  SCALING_GROUP_ID,
  SCALING_GROUP_NAME,
} from './sandbox-world-scaling';

const MAIN = WORLD_SERVERS.filter((server) => server.clusterId === CLUSTER_ID);
const RESERVED_PCT = Math.round(
  (MAIN.reduce((sum, s) => sum + worldRequested(s).memMi, 0) /
    MAIN.reduce((sum, s) => sum + s.ramMb, 0)) *
    100,
);

type Params = Record<string, string | undefined>;

const NODE_OUTCOMES = new Set([
  'added',
  'replaced',
  'removed',
  'node-ordered',
  'node-joined',
  'purchase-failed',
  'node-drained',
  'node-removed',
]);

function decisionsOf(now: number, collapse: boolean) {
  const burst = SERVER_PRICES[BURST_WORKER.productName];
  const done = (id: string, at: number) =>
    mark({
      id: `example-operation-${id}`,
      state: 'completed',
      progress: 100,
      step: null,
      error: null,
      finishedAt: hoursAgo(now, at),
    });
  const decision = (
    index: number,
    atHours: number,
    fields: {
      force: string;
      outcome: string;
      saw: string;
      did: string;
      why: string;
      bought?: boolean;
      operation?: ReturnType<typeof done> | null;
      considered?: unknown[];
    },
  ) =>
    mark({
      id: `example-decision-${index}`,
      at: hoursAgo(now, atHours),
      force: fields.force,
      outcome: fields.outcome,
      saw: fields.saw,
      did: fields.did,
      why: fields.why,
      asks: null,
      shape: fields.bought ? burst.serverType : null,
      region: fields.bought ? REGION : null,
      hourlyEur: fields.bought ? burst.hourlyNet : null,
      considered: fields.considered ?? [],
      operation: fields.operation ?? null,
      ...(collapse ? { repeats: 1 } : {}),
    });
  const quiet = {
    ...decision(1, LAST_LOOK_HOURS, {
      force: 'opportunity',
      outcome: 'declined',
      saw: `${MACHINES.length} nodes, ${RESERVED_PCT}% of memory reserved, nothing waiting.`,
      did: 'Nothing.',
      why: `The fleet is at its minimum of ${BOUNDS.min} nodes, so there is nothing to remove.`,
    }),
    ...(collapse ? { repeats: 96, since: hoursAgo(now, 24) } : {}),
  };
  const added = BURST_WORKER.addedHoursAgo;
  const removed = BURST_WORKER.removedHoursAgo;
  return [
    quiet,
    decision(2, removed, {
      force: 'opportunity',
      outcome: 'node-removed',
      saw: `${BURST_WORKER.name} empty since its last application moved.`,
      did: `Gave back ${BURST_WORKER.name} (${burst.serverType}, ${REGION}).`,
      why: 'A quiet night: the import had finished, and the other workers held everything else with room to spare.',
      bought: true,
      operation: done('2', removed),
    }),
    decision(3, removed + 0.5, {
      force: 'opportunity',
      outcome: 'node-drained',
      saw: `${BURST_WORKER.name} 7% used for six hours.`,
      did: `Moved its applications to the other workers.`,
      why: 'Everything on it fitted elsewhere, and nothing on it keeps data on the machine.',
      bought: true,
      operation: done('3', removed + 0.5),
    }),
    decision(4, added - 0.2, {
      force: 'urgency',
      outcome: 'node-joined',
      saw: `${BURST_WORKER.name} ready.`,
      did: `${BURST_WORKER.name} joined the cluster and the waiting application started on it.`,
      why: 'Added 12 minutes earlier.',
      bought: true,
      operation: done('4', added - 0.2),
    }),
    decision(5, added, {
      force: 'urgency',
      outcome: 'node-ordered',
      saw: '1 app with nowhere to run: the catalogue import asking for 3 CPU and 13 GiB.',
      did: `Added ${burst.serverType} in ${REGION}.`,
      why: `The cheapest machine on the list big enough for it, and the fleet stays under the spending ceiling of €${CEILING_EUR} a month.`,
      bought: true,
      operation: done('5', added - 0.2),
      considered: [
        mark({
          shape: SERVER_PRICES.CX33.serverType,
          region: REGION,
          hourlyEur: SERVER_PRICES.CX33.hourlyNet,
          outcome: 'does-not-fit',
          note: '4 CPU and 8 GiB cannot hold 3 CPU and 13 GiB.',
        }),
        mark({
          shape: burst.serverType,
          region: REGION,
          hourlyEur: burst.hourlyNet,
          outcome: 'would-buy',
        }),
      ],
    }),
  ];
}

/** Filtered the way the real list filters: by outcome, by window, newest first. */
export function exampleScalingDecisions(
  now: number,
  query?: SandboxStandInQuery,
  params?: Params,
) {
  if (!isExampleGroup(params)) return [];
  const q = query ?? {};
  const wanted =
    typeof q.outcome === 'string' && q.outcome
      ? q.outcome.split(',').map((o) => o.trim())
      : null;
  const at = (key: string) =>
    typeof q[key] === 'string' ? Date.parse(q[key] as string) : Number.NaN;
  const before = at('before');
  const since = at('since');
  const until = at('until');
  const limit =
    typeof q.limit === 'string' || typeof q.limit === 'number'
      ? Number.parseInt(String(q.limit), 10)
      : Number.NaN;

  const rows = decisionsOf(now, q.collapse === 'true' || q.collapse === true)
    .filter(
      (d) =>
        !wanted ||
        wanted.includes(d.outcome) ||
        (wanted.includes('nodes') && NODE_OUTCOMES.has(d.outcome)),
    )
    .filter((d) => Number.isNaN(before) || Date.parse(d.at) < before)
    .filter((d) => Number.isNaN(since) || Date.parse(d.at) >= since)
    .filter((d) => Number.isNaN(until) || Date.parse(d.at) <= until);
  return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
}

export function exampleClusterScalingDecisions(
  now: number,
  query?: SandboxStandInQuery,
) {
  return exampleScalingDecisions(now, query).map((d) => ({
    ...d,
    groupId: SCALING_GROUP_ID,
    groupName: SCALING_GROUP_NAME,
  }));
}
