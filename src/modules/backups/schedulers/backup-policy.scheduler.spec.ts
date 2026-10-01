// Pulled in transitively and ships ESM jest will not parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BackupPolicyScheduler } from './backup-policy.scheduler';

/**
 * A policy is born with `nextRunAt` null and `tick` only selects rows already
 * due, so nothing could ever make one due: every scheduled backup on the
 * installation waited forever while the policy read enabled and active. The
 * backfill that fixes it existed, said in its own docstring that it ran at
 * boot, and had no caller.
 */
describe('BackupPolicyScheduler, the first run a policy ever gets', () => {
  function make() {
    const scheduler = Object.create(
      BackupPolicyScheduler.prototype,
    ) as BackupPolicyScheduler;
    const r = scheduler as unknown as Record<string, unknown>;
    const found: unknown[] = [];
    const updated: { id: string; patch: Record<string, unknown> }[] = [];
    r.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    r.policyRepo = {
      find: jest.fn(async (q: unknown) => {
        found.push(q);
        return [{ id: 'p-1', cronSchedule: '0 2 * * *' }];
      }),
      update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
        updated.push({ id, patch });
      }),
    };
    return { scheduler, found, updated };
  }

  it('is computed at boot, not left for a tick that cannot select it', async () => {
    const h = make();

    h.scheduler.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.updated).toHaveLength(1);
    expect(h.updated[0].id).toBe('p-1');
    expect(h.updated[0].patch.nextRunAt).toBeInstanceOf(Date);
    expect((h.updated[0].patch.nextRunAt as Date).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('looks only at policies that have a schedule and no next run', async () => {
    const h = make();

    await h.scheduler.backfillNextRun();

    const where = (h.found[0] as { where: Record<string, unknown> }).where;
    expect(where.enabled).toBe(true);
    expect(where.cronSchedule).toBeDefined();
    expect(where.nextRunAt).toBeDefined();
  });

  it('does not bring the application down when a cron cannot be parsed', async () => {
    const h = make();
    (h.scheduler as unknown as Record<string, unknown>).policyRepo = {
      find: jest.fn(async () => [{ id: 'p-1', cronSchedule: 'not a cron' }]),
      update: jest.fn(),
    };

    await expect(h.scheduler.backfillNextRun()).resolves.toBeUndefined();
  });
});

/**
 * The scheduler launched the daily policy of a cluster deleted weeks earlier:
 * every run failed against nothing and raised "needs attention" on the backup
 * overview.
 */
describe('BackupPolicyScheduler, a policy whose cluster is gone', () => {
  const PAST = new Date(Date.now() - 60_000);
  function make(cluster: Record<string, unknown> | null) {
    const scheduler = Object.create(
      BackupPolicyScheduler.prototype,
    ) as BackupPolicyScheduler;
    const r = scheduler as unknown as Record<string, unknown>;
    const policy = {
      id: 'p-1',
      clusterId: 'c-1',
      cronSchedule: '0 2 * * *',
      enabled: true,
      status: 'active',
      nextRunAt: PAST,
      metadata: { keep: 'me' },
    };
    const saved: Record<string, unknown>[] = [];
    const updated: { id: string; patch: Record<string, unknown> }[] = [];
    const jobs: unknown[] = [];
    r.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    r.policyRepo = {
      find: jest.fn(async () => [policy]),
      update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
        updated.push({ id, patch });
      }),
      save: jest.fn(async (p: Record<string, unknown>) => {
        saved.push({ ...p });
      }),
    };
    r.clusterRepo = {
      find: jest.fn(async () => (cluster ? [{ id: 'c-1', ...cluster }] : [])),
    };
    r.jobsService = {
      createOnDemand: jest.fn(async (...args: unknown[]) => {
        jobs.push(args);
      }),
    };
    return { scheduler, saved, updated, jobs };
  }

  it('pauses it with the reason instead of launching a job, when the cluster was deleted', async () => {
    const h = make({ status: 'deleted' });
    await h.scheduler.tick();

    expect(h.jobs).toHaveLength(0);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      enabled: false,
      status: 'paused',
      nextRunAt: null,
      metadata: { keep: 'me', pausedReason: 'cluster_gone' },
    });
  });

  it('pauses it when the cluster row is gone altogether', async () => {
    const h = make(null);
    await h.scheduler.tick();
    expect(h.jobs).toHaveLength(0);
    expect(h.saved[0]).toMatchObject({ status: 'paused' });
  });

  it('only skips the run for a lost cluster, which a rebuild may bring back', async () => {
    const h = make({ status: 'lost' });
    await h.scheduler.tick();

    expect(h.jobs).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
    expect(h.updated[0].patch.nextRunAt).toBeInstanceOf(Date);
  });

  it('runs as before for a cluster that exists', async () => {
    const h = make({ status: 'ready' });
    await h.scheduler.tick();
    expect(h.jobs).toHaveLength(1);
    expect(h.saved).toHaveLength(0);
  });

  it('retires, at boot, the active policies of clusters deleted before this code ran', async () => {
    const h = make({ status: 'deleted', deletedAt: new Date() });
    await expect(h.scheduler.retireGoneClusterPolicies()).resolves.toBe(1);
    expect(h.saved[0]).toMatchObject({ status: 'paused' });
  });
});
