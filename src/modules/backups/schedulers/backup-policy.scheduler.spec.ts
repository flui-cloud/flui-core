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
