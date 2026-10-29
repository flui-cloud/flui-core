import { InstancePod } from './primary-placement.core';

export interface DatabaseHaInstance {
  instance: string;
  node: string | null;
  zone: string | null;
  ready: boolean;
}

export interface DatabaseHaCopy extends DatabaseHaInstance {
  /** `quorum` copies can confirm a commit; `async` ones only follow. */
  confirms: boolean;
  /** How long the last writes took to be safe on this copy; null when nothing was written lately. */
  flushLagMs: number | null;
  replayLagMs: number | null;
}

export interface DatabaseHaPlacement {
  readAt: string;
  primary: DatabaseHaInstance | null;
  copies: DatabaseHaCopy[];
}

export const REPLICATION_SQL =
  'SELECT application_name, sync_state, ' +
  'round((extract(epoch FROM flush_lag) * 1000)::numeric, 1), ' +
  'round((extract(epoch FROM replay_lag) * 1000)::numeric, 1) ' +
  'FROM pg_stat_replication ORDER BY application_name';

const ms = (v: string | undefined) => (v ? Number(v) : null);

/** One row per copy from `psql -At`: name|sync_state|flush ms|replay ms. */
export function databaseHaPlacement(input: {
  primary: string | undefined;
  pods: InstancePod[];
  zoneOf: Map<string, string>;
  replication: string;
  now: Date;
}): DatabaseHaPlacement {
  const instance = (p: InstancePod): DatabaseHaInstance => ({
    instance: p.name,
    node: p.node ?? null,
    zone: (p.node && input.zoneOf.get(p.node)) || null,
    ready: p.ready,
  });
  const rows = new Map(
    input.replication
      .split('\n')
      .map((l) => l.trim().split('|'))
      .filter((r) => r[0])
      .map((r) => [r[0], r] as const),
  );
  const primary = input.pods.find((p) => p.name === input.primary);
  return {
    readAt: input.now.toISOString(),
    primary: primary ? instance(primary) : null,
    copies: input.pods
      .filter((p) => p.name !== input.primary)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => {
        const row = rows.get(p.name);
        return {
          ...instance(p),
          confirms: row?.[1] === 'quorum' || row?.[1] === 'sync',
          flushLagMs: ms(row?.[2]),
          replayLagMs: ms(row?.[3]),
        };
      }),
  };
}
