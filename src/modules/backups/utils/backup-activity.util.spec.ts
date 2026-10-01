import {
  ActivityArtifact,
  ActivityJob,
  ActivityPolicy,
  buildPolicyActivity,
  clampActivityLimit,
  computeHealth,
  describeCron,
  toBackupRun,
} from './backup-activity.util';

const NOW = new Date('2026-09-30T08:00:00Z');

function policy(overrides: Partial<ActivityPolicy> = {}): ActivityPolicy {
  return {
    id: 'pol-1',
    name: 'platform',
    engineClass: 'platform',
    status: 'active',
    enabled: true,
    cronSchedule: '0 2 * * *',
    nextRunAt: new Date('2026-10-01T02:00:00Z'),
    createdAt: new Date('2026-09-01T10:00:00Z'),
    ...overrides,
  };
}

function job(overrides: Partial<ActivityJob> = {}): ActivityJob {
  return {
    id: 'job-1',
    triggerType: 'scheduled',
    triggerContext: {},
    metadata: {},
    status: 'completed',
    startedAt: new Date('2026-09-29T02:00:05Z'),
    finishedAt: new Date('2026-09-29T02:03:05Z'),
    errorMessage: null,
    createdAt: new Date('2026-09-29T02:00:01Z'),
    ...overrides,
  };
}

const platformArtifacts: ActivityArtifact[] = [
  {
    sizeBytes: '4096',
    expiresAt: new Date('2026-10-29T02:03:05Z'),
    encryptionMode: 'operator',
    manifestSummary: {},
    locations: [{ state: 'available' }],
  },
  {
    sizeBytes: '1048576',
    expiresAt: new Date('2026-10-29T02:03:05Z'),
    encryptionMode: 'operator',
    manifestSummary: {},
    locations: [{ state: 'verified' }],
  },
];

describe('describeCron', () => {
  it.each([
    [null, 'On demand only'],
    ['', 'On demand only'],
    ['0 2 * * *', 'Every day at 02:00 UTC'],
    ['@daily', 'Every day at 00:00 UTC'],
    ['0 */6 * * *', 'Every 6 hours'],
    ['15 */4 * * *', 'Every 4 hours at minute 15'],
    ['0 * * * *', 'Every hour'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['30 3 * * 1', 'Mondays at 03:30 UTC'],
    ['30 3 * * MON,THU', 'Mondays and Thursdays at 03:30 UTC'],
    ['0 4 * * 1-5', 'Weekdays at 04:00 UTC'],
    ['0 4 * * 0,6', 'Weekends at 04:00 UTC'],
    ['0 0,12 * * *', 'Every day at 00:00 and 12:00 UTC'],
    ['0 2 1 * *', 'On day 1 of every month at 02:00 UTC'],
    ['0 2 * 1 *', 'Cron 0 2 * 1 * (UTC)'],
    ['not a cron', 'Cron not a cron (UTC)'],
  ])('%p reads as %p', (cron, words) => {
    expect(describeCron(cron)).toBe(words);
  });
});

describe('computeHealth', () => {
  const none = new Map<string, ActivityArtifact[]>();

  it('calls the 02:00 run of 30 Sep that never started missed', () => {
    const h = computeHealth(policy(), [job()], none, NOW);
    expect(h).toEqual({
      state: 'missed',
      detail: 'The run due at 02:00 UTC on 30 Sep did not start.',
      lastSuccessAt: '2026-09-29T02:03:05.000Z',
    });
  });

  it('gives the run 15 minutes before it can be missed', () => {
    const h = computeHealth(
      policy(),
      [job()],
      none,
      new Date('2026-09-30T02:10:00Z'),
    );
    expect(h.state).toBe('ok');
  });

  it('counts a job enqueued up to 5 minutes early as the due run', () => {
    const early = job({
      id: 'job-2',
      createdAt: new Date('2026-09-30T01:56:00Z'),
      startedAt: new Date('2026-09-30T01:56:00Z'),
      finishedAt: new Date('2026-09-30T01:58:00Z'),
    });
    expect(computeHealth(policy(), [job(), early], none, NOW).state).toBe('ok');
  });

  it('does not miss a run that was due before the policy existed', () => {
    const h = computeHealth(
      policy({ createdAt: new Date('2026-09-30T03:00:00Z') }),
      [],
      none,
      NOW,
    );
    expect(h.state).toBe('never_run');
    expect(h.detail).toBe(
      'No backup has run yet; the first is due at 02:00 UTC on 1 Oct.',
    );
  });

  it('says a policy was paused because its cluster is gone, and raises no alarm', () => {
    const failedRun = job({ status: 'failed', errorMessage: 'cluster gone' });
    const h = computeHealth(
      policy({
        status: 'paused',
        enabled: false,
        metadata: { pausedReason: 'cluster_gone' },
      }),
      [failedRun],
      none,
      NOW,
    );
    expect(h.state).toBe('paused');
    expect(h.detail).toBe(
      'Paused because its cluster no longer exists. The backups it took stay restorable.',
    );
  });

  it('reads a paused policy as paused before anything else', () => {
    expect(
      computeHealth(policy({ status: 'paused', enabled: false }), [], none, NOW)
        .state,
    ).toBe('paused');
  });

  it('reads a pending or running job as running', () => {
    const running = job({
      id: 'job-2',
      status: 'running',
      startedAt: new Date('2026-09-30T07:59:00Z'),
      finishedAt: null,
      createdAt: new Date('2026-09-30T07:58:00Z'),
    });
    const h = computeHealth(policy(), [job(), running], none, NOW);
    expect(h.state).toBe('running');
    expect(h.detail).toBe(
      'A backup started at 07:59 UTC on 30 Sep is in progress.',
    );
  });

  it('reads the newest finished run failing as failed, with its reason', () => {
    const failed = job({
      id: 'job-2',
      status: 'failed',
      startedAt: new Date('2026-09-30T02:00:03Z'),
      finishedAt: new Date('2026-09-30T02:00:40Z'),
      createdAt: new Date('2026-09-30T02:00:01Z'),
      errorMessage: 'destination unreachable',
    });
    const h = computeHealth(policy(), [job(), failed], none, NOW);
    expect(h.state).toBe('failed');
    expect(h.detail).toBe(
      'The run that ended at 02:00 UTC on 30 Sep failed: destination unreachable',
    );
    expect(h.lastSuccessAt).toBe('2026-09-29T02:03:05.000Z');
  });

  it('reads a partial run that captured nothing as failed, one that did as fine', () => {
    const partial = job({
      id: 'job-2',
      status: 'partially_completed',
      startedAt: new Date('2026-09-30T02:00:03Z'),
      finishedAt: new Date('2026-09-30T02:05:00Z'),
      createdAt: new Date('2026-09-30T02:00:01Z'),
    });
    expect(computeHealth(policy(), [job(), partial], none, NOW).state).toBe(
      'failed',
    );
    const captured = new Map([['job-2', platformArtifacts]]);
    expect(computeHealth(policy(), [job(), partial], captured, NOW).state).toBe(
      'ok',
    );
  });

  it('reads a policy without a schedule as on demand, or never run', () => {
    const manual = policy({ cronSchedule: null, nextRunAt: null });
    expect(computeHealth(manual, [job()], none, NOW).state).toBe('on_demand');
    expect(computeHealth(manual, [], none, NOW)).toEqual({
      state: 'never_run',
      detail:
        'No backup has been taken yet; this policy runs only when started.',
      lastSuccessAt: null,
    });
  });

  it('reads a scheduled run that happened as ok', () => {
    const today = job({
      id: 'job-2',
      createdAt: new Date('2026-09-30T02:00:01Z'),
      startedAt: new Date('2026-09-30T02:00:04Z'),
      finishedAt: new Date('2026-09-30T02:02:04Z'),
    });
    expect(computeHealth(policy(), [job(), today], none, NOW)).toEqual({
      state: 'ok',
      detail: 'The last run succeeded at 02:02 UTC on 30 Sep.',
      lastSuccessAt: '2026-09-30T02:02:04.000Z',
    });
  });
});

describe('toBackupRun', () => {
  it('sums both platform artifacts and reads operator sealing as encrypted', () => {
    const run = toBackupRun(job(), platformArtifacts, NOW);
    expect(run).toEqual({
      jobId: 'job-1',
      trigger: 'scheduled',
      status: 'completed',
      startedAt: '2026-09-29T02:00:05.000Z',
      finishedAt: '2026-09-29T02:03:05.000Z',
      durationSeconds: 180,
      sizeBytes: 1052672,
      encrypted: true,
      expiresAt: '2026-10-29T02:03:05.000Z',
      stored: 'present',
      errorMessage: null,
    });
  });

  it('reads the repository cipher before the encryption mode', () => {
    const plain = toBackupRun(
      job(),
      [
        {
          sizeBytes: null,
          encryptionMode: 'flui_managed',
          manifestSummary: { repository: { cipher: 'none' } },
          locations: [{ state: 'available' }],
        },
      ],
      NOW,
    );
    expect(plain.encrypted).toBe(false);
    expect(plain.sizeBytes).toBeNull();
    const sealed = toBackupRun(
      job(),
      [
        {
          encryptionMode: 'flui_managed',
          manifestSummary: { repository: { cipher: 'rclone-crypt-v1' } },
        },
      ],
      NOW,
    );
    expect(sealed.encrypted).toBe(true);
  });

  it('knows nothing about a run without artifacts', () => {
    const run = toBackupRun(
      job({ status: 'failed', finishedAt: null }),
      [],
      NOW,
    );
    expect(run).toMatchObject({
      sizeBytes: null,
      encrypted: null,
      stored: 'unknown',
      durationSeconds: null,
    });
  });

  it('reads a copy past its expiry as expired, a lost one as missing', () => {
    expect(
      toBackupRun(
        job(),
        [
          {
            expiresAt: new Date('2026-09-01T00:00:00Z'),
            locations: [{ state: 'available' }],
          },
        ],
        NOW,
      ).stored,
    ).toBe('expired');
    expect(
      toBackupRun(job(), [{ locations: [{ state: 'missing' }] }], NOW).stored,
    ).toBe('missing');
  });

  it('names the trigger: platform update, manual, and a legacy scheduled row', () => {
    expect(
      toBackupRun(
        job({
          triggerType: 'on_demand',
          triggerContext: { platformUpdate: 'op-1' },
        }),
        [],
        NOW,
      ).trigger,
    ).toBe('platform_update');
    expect(
      toBackupRun(
        job({
          triggerType: 'on_demand',
          createdAt: new Date('2026-09-29T11:17:00Z'),
        }),
        [],
        NOW,
        '0 2 * * *',
      ).trigger,
    ).toBe('manual');
    expect(
      toBackupRun(job({ triggerType: 'on_demand' }), [], NOW, '0 2 * * *')
        .trigger,
    ).toBe('scheduled');
  });
});

describe('buildPolicyActivity', () => {
  it('assembles schedule, health and runs newest first, capped by the limit', () => {
    const older = job({
      id: 'job-0',
      createdAt: new Date('2026-09-28T02:00:01Z'),
      startedAt: new Date('2026-09-28T02:00:05Z'),
      finishedAt: new Date('2026-09-28T02:03:00Z'),
    });
    const activity = buildPolicyActivity(
      policy(),
      [older, job()],
      new Map([['job-1', platformArtifacts]]),
      NOW,
      1,
    );
    expect(activity.schedule).toEqual({
      cron: '0 2 * * *',
      description: 'Every day at 02:00 UTC',
      timezone: 'UTC',
      nextRunAt: '2026-10-01T02:00:00.000Z',
      previousDueAt: '2026-09-30T02:00:00.000Z',
    });
    expect(activity.health.state).toBe('missed');
    expect(activity.runs.map((r) => r.jobId)).toEqual(['job-1']);
    expect(activity.lastRun?.sizeBytes).toBe(1052672);
  });

  it('shows no next run for a paused policy', () => {
    const activity = buildPolicyActivity(
      policy({ status: 'paused', enabled: false }),
      [],
      new Map(),
      NOW,
    );
    expect(activity.schedule.nextRunAt).toBeNull();
    expect(activity.lastRun).toBeNull();
  });
});

describe('clampActivityLimit', () => {
  it.each([
    [undefined, 30],
    ['abc', 30],
    ['0', 30],
    ['5', 5],
    ['500', 100],
  ])('%p gives %p', (raw, limit) => {
    expect(clampActivityLimit(raw)).toBe(limit);
  });
});
