import { AppCoverageService } from './app-coverage.service';
import { BackupScope } from '../enums/backup-scope.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import { BackupJobStatus } from '../enums/backup-job.enum';

const NOW = new Date('2026-09-27T12:00:00Z');

const app = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  slug: id,
  kind: 'APPLICATION',
  category: 'user',
  clusterId: 'c1',
  k8sNamespace: `ns-${id}`,
  volumes: [],
  workloadKind: 'Deployment',
  ...over,
});

const policy = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  clusterId: 'c1',
  scope: BackupScope.CLUSTER_ALL,
  engineClass: BackupEngineClass.VOLUME,
  scopeSelector: {},
  includePvcs: true,
  cronSchedule: '0 3 * * *',
  enabled: true,
  status: BackupPolicyStatus.ACTIVE,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

function build(opts: {
  policies: unknown[];
  jobs: Array<{
    policyId: string;
    applicationId: string | null;
    at: string;
    skipped?: string[];
  }>;
  liveClusters?: string[];
  apps?: unknown[];
}) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'leftJoin',
    'orderBy',
    'limit',
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn(async () =>
    [...opts.jobs].sort((a, b) => b.at.localeCompare(a.at)),
  );
  const apps = {
    find: jest.fn(async () => opts.apps ?? []),
    findOne: jest.fn(),
  };
  const clusters = {
    find: jest.fn(async (q: { where: { id?: unknown } }) =>
      q.where.id
        ? [{ id: 'c1', name: 'wc-1' }]
        : (opts.liveClusters ?? ['c1']).map((id) => ({ id })),
    ),
  };
  const policies = { find: jest.fn(async () => opts.policies) };
  const jobs = { createQueryBuilder: jest.fn(() => qb) };
  return {
    qb,
    apps,
    service: new AppCoverageService(
      apps as never,
      clusters as never,
      policies as never,
      jobs as never,
    ),
  };
}

describe('AppCoverageService', () => {
  it('counts finished runs, and a run naming one app only for that app', async () => {
    const { service, qb } = build({
      policies: [
        policy('cluster'),
        policy('db', {
          engineClass: BackupEngineClass.DATABASE,
          scopeSelector: { applicationIds: ['pg'] },
          retentionDays: 14,
          nextRunAt: new Date('2026-09-28T03:00:00Z'),
        }),
      ],
      jobs: [
        { policyId: 'db', applicationId: 'pg', at: '2026-09-27T03:02:00Z' },
        {
          policyId: 'cluster',
          applicationId: null,
          at: '2026-09-10T03:02:00Z',
        },
      ],
    });

    const result = await service.forApplications(
      [
        app('pg', { kind: 'DATABASE' }),
        app('web', { volumes: [{ name: 'd', mountPath: '/d' }] }),
        app('static'),
      ] as never,
      NOW,
    );

    expect(qb.andWhere).toHaveBeenCalledWith('j.status IN (:...statuses)', {
      statuses: [
        BackupJobStatus.COMPLETED,
        BackupJobStatus.PARTIALLY_COMPLETED,
      ],
    });
    const byId = Object.fromEntries(
      result.applications.map((r) => [r.applicationId, r]),
    );
    expect(byId.pg).toMatchObject({
      coverage: 'protected',
      alarm: false,
      clusterName: 'wc-1',
      policy: {
        id: 'db',
        engineClass: 'database',
        schedule: '0 3 * * *',
        retentionDays: 14,
        nextRunAt: '2026-09-28T03:00:00.000Z',
      },
      lastSuccessAt: '2026-09-27T03:02:00.000Z',
      protectedUntil: '2026-09-29T03:00:00.000Z',
      protectPath: null,
    });
    expect(byId.web).toMatchObject({
      coverage: 'unprotected',
      reason: 'stale',
      alarm: true,
      lastSuccessAt: '2026-09-10T03:02:00.000Z',
      protectedUntil: null,
      protectPath:
        '/management/backup/policies/new?clusterId=c1&applicationId=web',
    });
    expect(byId.static.protectPath).toBeNull();
    expect(byId.static).toMatchObject({ holdsData: false, alarm: false });
    expect(result.applications[0].applicationId).toBe('web');
    expect(result.summary).toEqual({
      applications: 3,
      holdingData: 2,
      protected: 1,
      pending: 0,
      toVerify: 0,
      unprotected: 2,
      alarms: 1,
    });
  });

  it('asks nothing of the job history when no policy exists', async () => {
    const { service, qb } = build({ policies: [], jobs: [] });
    const result = await service.forApplications([app('a')] as never, NOW);
    expect(qb.getRawMany).not.toHaveBeenCalled();
    expect(result.applications[0]).toMatchObject({ reason: 'no_policy' });
  });

  it('leaves out applications on clusters that are gone', async () => {
    const { service, apps } = build({
      policies: [],
      jobs: [],
      liveClusters: [],
    });
    expect(await service.candidates()).toEqual([]);
    expect(await service.candidates('c1')).toEqual([]);
    expect(apps.find).not.toHaveBeenCalled();
  });

  it('does not call a database protected by a run that left its volume out', async () => {
    const { service } = build({
      policies: [policy('auto-daily')],
      jobs: [
        {
          policyId: 'auto-daily',
          applicationId: null,
          at: '2026-09-27T03:02:00Z',
          skipped: ['ns-pg-0/pg-x1-0/data'],
        },
      ],
    });
    const result = await service.forApplications(
      [
        app('pg', {
          slug: 'pg-x1',
          k8sNamespace: 'ns-pg-0',
          kind: 'DATABASE',
          workloadKind: 'StatefulSet',
          volumes: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
        }),
        app('web', {
          k8sNamespace: 'ns-pg-0',
          volumes: [{ name: 'd', mountPath: '/d' }],
        }),
      ] as never,
      NOW,
    );
    const byId = Object.fromEntries(
      result.applications.map((r) => [r.applicationId, r]),
    );
    expect(byId.pg).toMatchObject({
      coverage: 'unprotected',
      reason: 'left_out',
      alarm: true,
    });
    expect(byId.web).toMatchObject({ coverage: 'protected', alarm: false });
  });
});
