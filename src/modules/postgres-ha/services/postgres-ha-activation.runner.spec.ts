import {
  HaActivationError,
  HaActivationPlan,
  HaActivationPorts,
  PostgresHaActivationRunner,
} from './postgres-ha-activation.runner';
import { DatabaseHaSpec } from '../postgres-ha.types';

const plan: HaActivationPlan = {
  appId: 'app-1',
  slug: 'orders-db',
  namespace: 'p-orders',
  durability: 'required',
  instances: 3,
  preferredZones: ['fsn1', 'nbg1'],
  storageClass: 'flui-local',
  sizeGi: 10,
  podNetwork: '10.42.0.0/16',
  replicationPassword: 'abcdefghij0123456789',
};

interface Script {
  fenceFails?: boolean;
  superuserPassword?: string | null;
  readyAfterPolls?: number;
  settlingPolls?: number;
  caughtUp?: boolean;
  promoted?: boolean;
}

function setup(script: Script = {}) {
  const calls: string[] = [];
  const states: DatabaseHaSpec[] = [];
  let clock = 0;
  let readyPolls = 0;
  let settlePolls = 0;
  const record = (call: string): void => {
    calls.push(call);
  };
  const ports: HaActivationPorts = {
    ensureOperator: async () => record('operator'),
    sourceSql: async (sql) => {
      calls.push(`source-sql:${sql.slice(0, 30)}`);
      return sql.includes('pg_current_wal_lsn') ? '0/14000000\n' : '';
    },
    sourceShell: async () => (calls.push('source-hba'), ''),
    fenceSource: async () => {
      record('fence');
      if (script.fenceFails) throw new Error('Unexpected server response: 400');
    },
    unfenceSource: async () => record('unfence'),
    apply: async (objects) =>
      record(`apply:${objects.map((o) => o.kind).join('+')}`),
    readyInstances: async () => {
      readyPolls++;
      if (calls.includes('scale:0')) {
        settlePolls++;
        calls.push('ready-after-switch');
        return settlePolls > (script.settlingPolls ?? 0) ? 3 : 2;
      }
      return readyPolls > (script.readyAfterPolls ?? 0) ? 3 : 1;
    },
    primaryPod: async () => 'orders-db-ha-1',
    clusterSql: async (_pod, sql) => {
      if (sql.includes('pg_last_wal_replay_lsn')) {
        return script.caughtUp === false ? 'f' : 't';
      }
      if (sql.includes('pg_is_in_recovery')) {
        return script.promoted === false ? 't' : 'f';
      }
      return '';
    },
    patchCluster: async (_c, patch) =>
      record(`promote:${JSON.stringify(patch)}`),
    patchAppService: async () => record('switch-service'),
    scaleSingleInstance: async (n) => record(`scale:${n}`),
    superuserPassword: async () => script.superuserPassword ?? null,
    saveState: async (spec) => {
      states.push(spec);
      calls.push(`state:${spec.state}`);
    },
    progress: async (step) => record(`step:${step}`),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(1_800_000_000_000 + clock),
  };
  const runner = new PostgresHaActivationRunner(ports, {
    copyMs: 10_000,
    catchUpMs: 5_000,
    promoteMs: 5_000,
    pollMs: 1_000,
  });
  return { runner, calls, states };
}

describe('moving a database to its highly available cluster', () => {
  it('prepares, copies, holds writes, promotes and only then moves the application', async () => {
    const { runner, calls, states } = setup({ readyAfterPolls: 2 });
    const result = await runner.run(plan);
    expect(result).toMatchObject({
      engine: 'cnpg',
      cluster: 'orders-db-ha',
      state: 'active',
      instances: 3,
    });
    const order = (name: string) => calls.findIndex((c) => c.startsWith(name));
    expect(order('operator')).toBeLessThan(order('source-hba'));
    expect(order('apply:Secret+Cluster')).toBeLessThan(order('state:copying'));
    expect(order('state:copying')).toBeLessThan(order('fence'));
    expect(order('fence')).toBeLessThan(order('promote'));
    expect(order('promote')).toBeLessThan(order('state:active'));
    expect(order('state:active')).toBeLessThan(order('switch-service'));
    expect(calls.filter((c) => c !== 'ready-after-switch').at(-1)).toBe(
      'scale:0',
    );
    expect(calls).not.toContain('unfence');
    expect(states.map((s) => s.state)).toEqual(['copying', 'active']);
  });

  it('ends once every instance serves again after the switch, not while the copies restart', async () => {
    const { runner, calls } = setup({ settlingPolls: 2 });

    await runner.run(plan);

    const settling = calls.filter((c) => c === 'ready-after-switch');
    expect(settling).toHaveLength(3);
    expect(calls.at(-1)).toBe('ready-after-switch');
  });

  it('never holds writes when the copy does not become ready', async () => {
    const { runner, calls, states } = setup({ readyAfterPolls: 1000 });
    await expect(runner.run(plan)).rejects.toMatchObject({
      sourceServes: true,
    });
    expect(calls).not.toContain('fence');
    expect(states[states.length - 1].state).toBe('failed');
  });

  it('puts the single instance back in service when the copy does not catch up', async () => {
    const { runner, calls, states } = setup({ caughtUp: false });
    const error = await runner.run(plan).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HaActivationError);
    expect((error as HaActivationError).sourceServes).toBe(true);
    expect(calls.indexOf('unfence')).toBeGreaterThan(calls.indexOf('fence'));
    expect(calls.some((c) => c.startsWith('promote'))).toBe(false);
    expect(states[states.length - 1]).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining('single instance again'),
    });
  });

  it('keeps the postgres password through the promotion when the application signs in as postgres', async () => {
    const applied: Array<Record<string, unknown>> = [];
    const { runner } = setup({ superuserPassword: 's3cret' });
    const apply = (runner as unknown as { ports: HaActivationPorts }).ports
      .apply;
    (runner as unknown as { ports: HaActivationPorts }).ports.apply = async (
      objects,
    ) => {
      applied.push(...objects);
      return apply(objects);
    };
    await runner.run(plan);
    const secret = applied.find(
      (o) => (o.metadata as { name: string }).name === 'orders-db-ha-superuser',
    );
    expect(secret).toMatchObject({
      type: 'kubernetes.io/basic-auth',
      stringData: { username: 'postgres', password: 's3cret' },
    });
    const cluster = applied.find((o) => o.kind === 'Cluster') as {
      spec: Record<string, unknown>;
    };
    expect(cluster.spec).toMatchObject({
      enableSuperuserAccess: true,
      superuserSecret: { name: 'orders-db-ha-superuser' },
    });
  });

  it('a fence that fails leaves the single instance serving and the activation retryable', async () => {
    const { runner, calls, states } = setup({ fenceFails: true });
    const error = await runner.run(plan).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HaActivationError);
    expect((error as HaActivationError).sourceServes).toBe(true);
    expect(calls).toContain('unfence');
    expect(calls.some((c) => c.startsWith('promote'))).toBe(false);
    expect(states[states.length - 1]).toMatchObject({ state: 'failed' });
  });

  /** Two primaries must never take writes, so nothing reverts on its own after promotion. */
  it('keeps writes held and moves nothing when the promotion is not confirmed', async () => {
    const { runner, calls } = setup({ promoted: false });
    await expect(runner.run(plan)).rejects.toMatchObject({
      sourceServes: false,
    });
    expect(calls).not.toContain('unfence');
    expect(calls).not.toContain('switch-service');
  });

  it('refuses a replication password that could break out of its SQL literal', async () => {
    const { runner, calls } = setup();
    await expect(
      runner.run({
        ...plan,
        replicationPassword: "x'; drop role postgres; --",
      }),
    ).rejects.toThrow(/letters and digits/);
    expect(calls).toEqual([]);
  });
});
