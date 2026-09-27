jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('./ghcr-secret-refresh.service', () => ({
  GhcrSecretRefreshService: class {},
}));
jest.mock('./application-manifest-generator.service', () => ({
  ApplicationManifestGeneratorService: class {},
}));

import { ScheduledJobsService } from './scheduled-jobs.service';

/** The `scheduled_jobs` table, in memory. */
export function memoryRecords(initial: any[] = []) {
  const rows: any[] = [...initial];
  const matches = (r: any, where: any = {}) =>
    Object.entries(where).every(([k, v]) => r[k] === v);
  return {
    rows,
    find: jest.fn(async (o: any = {}) =>
      rows.filter((r) => matches(r, o.where)),
    ),
    findOne: jest.fn(
      async (o: any = {}) => rows.find((r) => matches(r, o.where)) ?? null,
    ),
    create: jest.fn((x: any) => ({ ...x })),
    merge: jest.fn((a: any, b: any) => Object.assign(a, b)),
    save: jest.fn(async (x: any) => {
      const row = {
        id: x.id ?? `r${rows.length + 1}`,
        createdAt: new Date(),
        ...x,
      };
      const i = rows.findIndex((r) => r.id === row.id);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
      return row;
    }),
    delete: jest.fn(async (id: string) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    }),
  };
}

const APP = {
  id: 'app-1',
  slug: 'whoami',
  clusterId: 'c1',
  k8sNamespace: 'user-a',
};

function job(name: string, status: 'failed' | 'succeeded', start: string) {
  return {
    metadata: {
      name,
      labels: { 'flui.cloud/scheduled-job': 'noshell', 'flui-app-id': 'app-1' },
    },
    status: {
      startTime: start,
      ...(status === 'failed'
        ? {
            failed: 1,
            conditions: [
              {
                type: 'Failed',
                status: 'True',
                reason: 'BackoffLimitExceeded',
              },
            ],
          }
        : { succeeded: 1 }),
    },
  };
}

function build(jobs: any[], pods: any[] = []) {
  const k8s = {
    listResourcesByLabel: jest.fn().mockResolvedValue([
      {
        metadata: {
          name: 'whoami-noshell',
          labels: { 'flui.cloud/scheduled-job': 'noshell' },
        },
        spec: {
          schedule: '*/2 * * * *',
          suspend: false,
          jobTemplate: {
            spec: { template: { spec: { containers: [{ args: ['echo'] }] } } },
          },
        },
        status: {},
      },
    ]),
    listResources: jest.fn().mockResolvedValue(jobs),
    getResource: jest.fn().mockResolvedValue({
      metadata: {
        name: 'whoami-noshell',
        labels: { 'flui.cloud/scheduled-job': 'noshell' },
      },
      spec: {},
    }),
    listPodsByLabel: jest.fn().mockResolvedValue(pods),
  };
  const service = new ScheduledJobsService(
    {
      findOne: jest.fn().mockResolvedValue({ kubeconfigEncrypted: 'x' }),
    } as never,
    { findById: jest.fn().mockResolvedValue(APP) } as never,
    k8s as never,
    { decrypt: () => 'kc' } as never,
    null as never,
    null as never,
    memoryRecords() as never,
  );
  return service;
}

describe('ScheduledJobsService — a failing schedule is visible', () => {
  it('marks a schedule failing after three failed runs in a row', async () => {
    const service = build([
      job('j1', 'failed', '2026-09-26T21:20:00Z'),
      job('j2', 'failed', '2026-09-26T21:22:00Z'),
      job('j3', 'failed', '2026-09-26T21:24:00Z'),
    ]);
    const [schedule] = await service.listForApp('app-1');
    expect(schedule).toMatchObject({
      failing: true,
      consecutiveFailures: 3,
      lastRunStatus: 'Failed',
    });
  });

  it('is healthy again once a run succeeds', async () => {
    const service = build([
      job('j1', 'failed', '2026-09-26T21:20:00Z'),
      job('j2', 'failed', '2026-09-26T21:22:00Z'),
      job('j3', 'succeeded', '2026-09-26T21:24:00Z'),
    ]);
    const [schedule] = await service.listForApp('app-1');
    expect(schedule).toMatchObject({ failing: false, consecutiveFailures: 0 });
  });

  it('says why a run failed', async () => {
    const service = build(
      [job('j1', 'failed', '2026-09-26T21:20:00Z')],
      [
        {
          status: {
            containerStatuses: [
              {
                state: {
                  terminated: {
                    reason: 'StartError',
                    message:
                      'exec: "/bin/sh": stat /bin/sh: no such file or directory',
                  },
                },
              },
            ],
          },
        },
      ],
    );
    const [run] = await service.listRuns('app-1', 'noshell');
    expect(run.reason).toMatch(/no shell/);
  });
});

describe('ScheduledJobsService.realignImage', () => {
  it('moves every schedule of the app onto the image just released', async () => {
    const generateCronJob = jest
      .fn()
      .mockReturnValue({ yaml: 'kind: CronJob' });
    const applyManifest = jest.fn().mockResolvedValue([]);
    const cron = (name: string, image: string) => ({
      metadata: {
        name: `whoami-${name}`,
        labels: { 'flui.cloud/scheduled-job': name },
      },
      spec: {
        schedule: '*/2 * * * *',
        timeZone: 'Europe/Rome',
        suspend: true,
        jobTemplate: {
          spec: {
            template: {
              spec: { containers: [{ image, args: ['-c', 'echo ok'] }] },
            },
          },
        },
      },
    });
    const service = new ScheduledJobsService(
      {
        findOne: jest.fn().mockResolvedValue({ kubeconfigEncrypted: 'x' }),
      } as never,
      {
        findById: jest
          .fn()
          .mockResolvedValue({ ...APP, sourceType: 'docker_image' }),
      } as never,
      {
        listResourcesByLabel: jest
          .fn()
          .mockResolvedValue([
            cron('noshell', 'traefik/whoami:v1.12.0'),
            cron('fresh', 'traefik/whoami:v1.11.0-amd64'),
          ]),
        applyManifest,
      } as never,
      { decrypt: () => 'kc' } as never,
      { generateCronJob } as never,
      null as never,
      memoryRecords() as never,
    );

    await expect(
      service.realignImage('app-1', 'traefik/whoami:v1.11.0-amd64'),
    ).resolves.toBe(1);
    const [, spec, , override] = generateCronJob.mock.calls[0];
    expect(override).toBe('traefik/whoami:v1.11.0-amd64');
    expect(spec).toMatchObject({
      displayName: 'noshell',
      schedule: '*/2 * * * *',
      timezone: 'Europe/Rome',
      command: 'echo ok',
      suspend: true,
    });
  });
});

describe('ScheduledJobsService — schedules recorded by Flui', () => {
  const make = (onCluster: any[], records: any[] = []) => {
    const generateCronJob = jest
      .fn()
      .mockReturnValue({ yaml: 'kind: CronJob' });
    const applyManifest = jest.fn().mockResolvedValue([]);
    const repo = memoryRecords(records);
    const service = new ScheduledJobsService(
      {
        findOne: jest.fn().mockResolvedValue({ kubeconfigEncrypted: 'x' }),
      } as never,
      {
        findById: jest
          .fn()
          .mockResolvedValue({ ...APP, sourceType: 'docker_image' }),
      } as never,
      {
        listResourcesByLabel: jest.fn().mockResolvedValue(onCluster),
        listResources: jest.fn().mockResolvedValue([]),
        getResource: jest.fn().mockResolvedValue(null),
        deleteResource: jest.fn().mockResolvedValue(undefined),
        applyManifest,
      } as never,
      { decrypt: () => 'kc' } as never,
      { generateCronJob } as never,
      null as never,
      repo as never,
    );
    return { service, repo, generateCronJob };
  };
  const record = (over: any = {}) => ({
    id: 'r1',
    applicationId: 'app-1',
    name: 'nightly',
    resourceName: 'whoami-nightly',
    schedule: '0 3 * * *',
    command: 'echo hi',
    timezone: null,
    concurrencyPolicy: 'Forbid',
    enabled: true,
    origin: 'user',
    createdAt: new Date('2026-09-27T10:00:00Z'),
    ...over,
  });

  it('records a schedule that exists only on the cluster, as the person’s own', async () => {
    const cron = {
      metadata: {
        name: 'whoami-old',
        labels: { 'flui.cloud/scheduled-job': 'old' },
      },
      spec: {
        schedule: '*/5 * * * *',
        jobTemplate: {
          spec: {
            template: { spec: { containers: [{ args: ['-c', 'date'] }] } },
          },
        },
      },
    };
    const { service, repo } = make([cron]);
    const [listed] = await service.listForApp('app-1');
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({
      name: 'old',
      origin: 'user',
      command: 'date',
    });
    expect(listed).toMatchObject({ name: 'old', onCluster: true });
  });

  it('puts back, at release, a schedule the cluster lost', async () => {
    const { service, generateCronJob } = make([], [record()]);
    await expect(service.realignImage('app-1', 'img:2')).resolves.toBe(1);
    expect(generateCronJob.mock.calls[0][1]).toMatchObject({
      name: 'whoami-nightly',
      schedule: '0 3 * * *',
    });
  });

  it('lists a recorded schedule the cluster does not have yet', async () => {
    const { service } = make([], [record()]);
    const [listed] = await service.listForApp('app-1');
    expect(listed).toMatchObject({ name: 'nightly', onCluster: false });
  });

  it('leaves a schedule declared in flui.yaml to flui.yaml', async () => {
    const { service } = make([], [record({ origin: 'manifest' })]);
    await expect(service.remove('app-1', 'nightly')).rejects.toThrow(
      'flui.yaml',
    );
    await expect(
      service.update('app-1', 'nightly', { schedule: '* * * * *' } as any),
    ).rejects.toThrow('flui.yaml');
  });
});
