// Pulled in transitively and ships ESM jest will not parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BackupActivityService } from './backup-activity.service';

const NOW = new Date('2026-09-30T08:00:00Z');

const platformPolicy = {
  id: 'pol-1',
  name: 'platform',
  engineClass: 'platform',
  status: 'active',
  enabled: true,
  cronSchedule: '0 2 * * *',
  nextRunAt: new Date('2026-10-01T02:00:00Z'),
  createdAt: new Date('2026-09-01T10:00:00Z'),
};

const jobOf = (id: string, day: string, status = 'completed') => ({
  id,
  triggerType: 'scheduled',
  triggerContext: {},
  metadata: {},
  status,
  startedAt: new Date(`2026-09-${day}T02:00:05Z`),
  finishedAt: new Date(`2026-09-${day}T02:03:05Z`),
  errorMessage: null,
  createdAt: new Date(`2026-09-${day}T02:00:01Z`),
});

function make(jobs: ReturnType<typeof jobOf>[], lastCompleted = jobs[0]) {
  const policies = {
    findById: jest.fn(async () => platformPolicy),
    list: jest.fn(async () => [platformPolicy]),
  };
  const jobRepo = {
    findByPolicy: jest.fn(async (_id: string, take: number) =>
      jobs.slice(0, take),
    ),
    findLastCompletedByPolicy: jest.fn(async () => lastCompleted ?? null),
  };
  const artifacts = {
    listByJobs: jest.fn(async (ids: string[]) =>
      ids.flatMap((backupJobId) => [
        {
          backupJobId,
          engineRef: 'platform:keys',
          sizeBytes: '4096',
          encryptionMode: 'operator',
          manifestSummary: {},
          locations: [{ state: 'available' }],
        },
        {
          backupJobId,
          engineRef: 'platform:db',
          sizeBytes: '1048576',
          encryptionMode: 'operator',
          manifestSummary: {},
          locations: [{ state: 'available' }],
        },
      ]),
    ),
  };
  const service = new BackupActivityService(
    policies as never,
    jobRepo as never,
    artifacts as never,
  );
  return { service, jobRepo, artifacts };
}

describe('BackupActivityService', () => {
  it('reports the platform backup of 30 Sep that never started as missed', async () => {
    const { service } = make([jobOf('job-29', '29'), jobOf('job-28', '28')]);

    const activity = await service.forPolicy('pol-1', '30', NOW);

    expect(activity.health).toEqual({
      state: 'missed',
      detail: 'The run due at 02:00 UTC on 30 Sep did not start.',
      lastSuccessAt: '2026-09-29T02:03:05.000Z',
    });
    expect(activity.runs.map((r) => r.jobId)).toEqual(['job-29', 'job-28']);
    expect(activity.lastRun?.sizeBytes).toBe(1052672);
    expect(activity.lastRun?.encrypted).toBe(true);
  });

  it('keeps the last success in view when it is older than the window', async () => {
    const failures = Array.from({ length: 25 }, (_, i) =>
      jobOf(`job-f${i}`, '29', 'failed'),
    );
    const old = jobOf('job-old', '01');
    const { service } = make(failures, old);

    const activity = await service.forPolicy('pol-1', undefined, NOW);

    expect(activity.health.state).toBe('failed');
    expect(activity.health.lastSuccessAt).toBe('2026-09-01T02:03:05.000Z');
  });

  it('lists every visible policy with its last run and no history', async () => {
    const { service, artifacts } = make([jobOf('job-29', '29')]);

    const list = await service.forUser('user-1', NOW);

    expect(list).toHaveLength(1);
    expect(list[0].runs).toEqual([]);
    expect(list[0].lastRun?.jobId).toBe('job-29');
    expect(artifacts.listByJobs).toHaveBeenCalledWith(['job-29']);
  });

  it('asks for no more than 100 runs', async () => {
    const { service, jobRepo } = make([]);

    await service.forPolicy('pol-1', '1000', NOW);

    expect(jobRepo.findByPolicy).toHaveBeenCalledWith('pol-1', 100);
  });
});
