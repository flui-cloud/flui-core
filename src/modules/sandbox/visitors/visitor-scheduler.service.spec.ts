jest.mock('@kubernetes/client-node', () => ({}));

import { advisoryKey } from '../../common/leadership/advisory-lock';
import { VisitorSchedulerService } from './visitor-scheduler.service';
import { loadVisitorConfig } from './visitor.config';

const OPEN = {
  SANDBOX_ENABLED: 'true',
  SANDBOX_VISITORS_ENABLED: 'true',
};

describe('VisitorSchedulerService', () => {
  const build = (
    env: Record<string, string> = OPEN,
    held = true,
  ): {
    service: VisitorSchedulerService;
    locks: unknown[][];
    calls: string[];
  } => {
    const locks: unknown[][] = [];
    const calls: string[] = [];
    const dataSource = {
      createQueryRunner: () => ({
        connect: async () => undefined,
        release: async () => undefined,
        query: async (q: string, params: unknown[]) => {
          if (q.includes('pg_try_advisory_lock')) {
            locks.push(params);
            return [{ held }];
          }
          return [];
        },
      }),
    };
    const step = (name: string) =>
      jest.fn(async () => {
        calls.push(name);
        return 0;
      });
    const service = new VisitorSchedulerService(
      loadVisitorConfig(env),
      dataSource as never,
      { recycle: step('recycle'), refill: step('refill') } as never,
      { sweep: step('sweep') } as never,
      { purgeExpired: step('links') } as never,
      { renewIfDue: step('renew') } as never,
      { purge: step('refusals') } as never,
    );
    return { service, locks, calls };
  };

  const cronName = (method: keyof VisitorSchedulerService) =>
    (
      Reflect.getMetadata(
        'SCHEDULE_CRON_OPTIONS',
        VisitorSchedulerService.prototype[method] as object,
      ) as { name: string }
    ).name;

  it('names every job as local, so it runs on whichever copy carries the entrance', () => {
    expect(cronName('keepPool')).toBe('local:sandbox-visitor-pool');
    expect(cronName('sweepVisitors')).toBe('local:sandbox-visitor-sweep');
    expect(cronName('renewLoginClient')).toBe(
      'local:sandbox-visitor-login-client',
    );
  });

  it('keeps the pool under its own lock while the entrance is open', async () => {
    const t = build();
    await t.service.keepPool();
    expect(t.locks).toEqual([advisoryKey('sandbox-visitor-pool')]);
    expect(t.calls).toEqual(['recycle', 'refill']);
  });

  it('sweeps under its own lock: visitors, then upgrade handles, then refusals', async () => {
    const t = build();
    await t.service.sweepVisitors();
    expect(t.locks).toEqual([advisoryKey('sandbox-visitor-sweep')]);
    expect(t.calls).toEqual(['sweep', 'links', 'refusals']);
  });

  it('does nothing while another copy holds the lock', async () => {
    const t = build(OPEN, false);
    await t.service.keepPool();
    await t.service.sweepVisitors();
    expect(t.calls).toEqual([]);
  });

  it('with the entrance shut, makes no visitors but still sweeps those inside', async () => {
    const t = build({ SANDBOX_ENABLED: 'true' });
    await t.service.keepPool();
    await t.service.renewLoginClient();
    expect(t.locks).toEqual([]);
    await t.service.sweepVisitors();
    expect(t.calls).toEqual(['sweep', 'links', 'refusals']);
  });

  it('with the demo off, runs nothing at all', async () => {
    const t = build({});
    await t.service.keepPool();
    await t.service.sweepVisitors();
    await t.service.renewLoginClient();
    expect(t.locks).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('renews the login credential only with the entrance open and the provider reachable', async () => {
    const env = process.env;
    try {
      process.env = { ...env, ZITADEL_SERVICE_ACCOUNT_PAT: '' };
      const unreachable = build();
      await unreachable.service.renewLoginClient();
      expect(unreachable.calls).toEqual([]);

      process.env = {
        ...env,
        ZITADEL_SERVICE_ACCOUNT_PAT: 'service-pat',
        OIDC_ISSUER: 'https://auth.example.test',
      };
      const reachable = build();
      await reachable.service.renewLoginClient();
      expect(reachable.calls).toEqual(['renew']);
    } finally {
      process.env = env;
    }
  });

  it('never lets a failing sweep escape the clock', async () => {
    const t = build();
    (t.service as unknown as { sweep: { sweep: jest.Mock } }).sweep.sweep =
      jest.fn(async () => {
        throw new Error('database down');
      });
    await expect(t.service.sweepVisitors()).resolves.toBeUndefined();
  });
});
