jest.mock('../../../common/net/egress-guard', () => ({
  guardedRequest: jest.fn().mockResolvedValue({ status: 200 }),
}));

import { guardedRequest } from '../../../common/net/egress-guard';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import {
  isPlatformBackupFresh,
  MasterHeartbeatScheduler,
} from './master-heartbeat.scheduler';

const at = (iso: string) => new Date(iso);

// 2026-09-28 is a Monday.
describe('whether the last platform backup is fresh enough to keep the heartbeat', () => {
  it('forgives the weekend on a weekday schedule', () => {
    const cron = '0 3 * * 1-5';
    const friday = at('2026-09-25T03:20:00Z');
    expect(
      isPlatformBackupFresh(friday, cron, at('2026-09-28T02:00:00Z')),
    ).toBe(true);
    expect(
      isPlatformBackupFresh(friday, cron, at('2026-09-28T03:10:00Z')),
    ).toBe(true);
    expect(
      isPlatformBackupFresh(friday, cron, at('2026-09-28T03:30:00Z')),
    ).toBe(false);
  });

  it('notices the missed run of a twice-daily schedule', () => {
    const cron = '0 3,4 * * *';
    expect(
      isPlatformBackupFresh(
        at('2026-09-28T03:10:00Z'),
        cron,
        at('2026-09-28T04:10:00Z'),
      ),
    ).toBe(true);
    expect(
      isPlatformBackupFresh(
        at('2026-09-28T03:10:00Z'),
        cron,
        at('2026-09-28T04:30:00Z'),
      ),
    ).toBe(false);
    expect(
      isPlatformBackupFresh(
        at('2026-09-27T04:10:00Z'),
        cron,
        at('2026-09-28T03:50:00Z'),
      ),
    ).toBe(false);
  });

  it('follows an every-6-hours schedule', () => {
    const cron = '0 */6 * * *';
    const morning = at('2026-09-28T06:05:00Z');
    expect(
      isPlatformBackupFresh(morning, cron, at('2026-09-28T12:10:00Z')),
    ).toBe(true);
    expect(
      isPlatformBackupFresh(morning, cron, at('2026-09-28T13:00:00Z')),
    ).toBe(false);
    expect(
      isPlatformBackupFresh(
        at('2026-09-28T12:05:00Z'),
        cron,
        at('2026-09-28T13:00:00Z'),
      ),
    ).toBe(true);
  });

  it('reads @daily', () => {
    const yesterday = at('2026-09-27T00:05:00Z');
    expect(
      isPlatformBackupFresh(yesterday, '@daily', at('2026-09-28T00:10:00Z')),
    ).toBe(true);
    expect(
      isPlatformBackupFresh(yesterday, '@daily', at('2026-09-28T01:00:00Z')),
    ).toBe(false);
  });

  it('never goes silent within 45 minutes of a success on a frequent schedule', () => {
    expect(
      isPlatformBackupFresh(
        at('2026-09-28T11:20:00Z'),
        '*/5 * * * *',
        at('2026-09-28T12:00:00Z'),
      ),
    ).toBe(true);
  });

  it('keeps 45 minutes for a policy with no schedule or an unreadable one', () => {
    const last = at('2026-09-28T11:30:00Z');
    expect(isPlatformBackupFresh(last, null, at('2026-09-28T12:10:00Z'))).toBe(
      true,
    );
    expect(isPlatformBackupFresh(last, null, at('2026-09-28T12:20:00Z'))).toBe(
      false,
    );
    expect(
      isPlatformBackupFresh(last, 'not a cron', at('2026-09-28T12:20:00Z')),
    ).toBe(false);
  });

  it('is never fresh without a success', () => {
    expect(
      isPlatformBackupFresh(null, '0 3 * * *', at('2026-09-28T12:00:00Z')),
    ).toBe(false);
  });
});

describe('MasterHeartbeatScheduler — which policies count', () => {
  const posted = guardedRequest as jest.Mock;
  beforeEach(() => posted.mockClear());

  function build(
    policies: Array<Record<string, unknown>>,
    problems: string[] = [],
  ) {
    const jobFindOne = jest.fn().mockResolvedValue({
      finishedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const scheduler = new MasterHeartbeatScheduler(
      { find: jest.fn().mockResolvedValue(policies) } as never,
      { findOne: jobFindOne } as never,
      {
        check: jest
          .fn()
          .mockResolvedValue({ healthy: problems.length === 0, problems }),
      } as never,
    );
    return { scheduler, jobFindOne };
  }

  const platform = (over: Record<string, unknown>) => ({
    id: 'p1',
    engineClass: BackupEngineClass.PLATFORM,
    enabled: true,
    status: BackupPolicyStatus.ACTIVE,
    cronSchedule: '0 * * * *',
    metadata: { platform: { heartbeat: { url: 'https://hc.example.com/x' } } },
    ...over,
  });

  it('beats while an active policy has a fresh backup', async () => {
    const { scheduler } = build([platform({})]);
    await scheduler.tick();
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['disabled', { enabled: false }],
    ['paused', { status: BackupPolicyStatus.PAUSED }],
    ['degraded', { status: BackupPolicyStatus.DEGRADED }],
  ])(
    'does not let a %s policy keep the heartbeat alive',
    async (_label, over) => {
      const { scheduler } = build([platform(over)]);
      await scheduler.tick();
      expect(posted).not.toHaveBeenCalled();
    },
  );
});

describe('MasterHeartbeatScheduler — the installation must be healthy too', () => {
  const posted = guardedRequest as jest.Mock;
  beforeEach(() => posted.mockReset().mockResolvedValue({ status: 200 }));

  const platform = {
    id: 'p1',
    engineClass: BackupEngineClass.PLATFORM,
    enabled: true,
    status: BackupPolicyStatus.ACTIVE,
    cronSchedule: '0 * * * *',
    metadata: { platform: { heartbeat: { url: 'https://hc.example.com/x' } } },
  };
  const build = (problems: string[]) =>
    new MasterHeartbeatScheduler(
      { find: jest.fn().mockResolvedValue([platform]) } as never,
      {
        findOne: jest
          .fn()
          .mockResolvedValue({ finishedAt: new Date(Date.now() - 600_000) }),
      } as never,
      {
        check: jest
          .fn()
          .mockResolvedValue({ healthy: problems.length === 0, problems }),
      } as never,
    );

  it('withholds the beat while alerts could not be delivered, and says why', async () => {
    const scheduler = build([
      'alertmanager has no running copy, so alerts would not be delivered',
    ]);
    await scheduler.tick();

    expect(posted).not.toHaveBeenCalled();
    expect(scheduler.status()).toMatchObject({
      state: 'withheld',
      lastBeatAt: null,
      reasons: [
        'alertmanager has no running copy, so alerts would not be delivered',
      ],
    });
  });

  it('beats and remembers when, with a fresh backup and a healthy installation', async () => {
    const scheduler = build([]);
    await scheduler.tick();

    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls[0][0].data.installation).toBe('healthy');
    expect(scheduler.status().state).toBe('beating');
    expect(scheduler.status().lastBeatAt).not.toBeNull();
  });

  it('tells a beat that could not be delivered apart from one withheld', async () => {
    posted.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    const scheduler = build([]);
    await scheduler.tick();

    expect(scheduler.status()).toMatchObject({
      state: 'failing',
      reasons: ['The heartbeat could not be sent: connect ETIMEDOUT'],
    });
  });

  it('reads off when no heartbeat address is set', async () => {
    const scheduler = new MasterHeartbeatScheduler(
      {
        find: jest.fn().mockResolvedValue([{ ...platform, metadata: {} }]),
      } as never,
      { findOne: jest.fn() } as never,
      { check: jest.fn() } as never,
    );
    await scheduler.tick();
    expect(scheduler.status().state).toBe('off');
  });
});
