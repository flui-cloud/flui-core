jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ClusterProtectionService } from './cluster-protection.service';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { DestinationRole } from '../enums/destination-role.enum';

const support = {
  database: (e: string) => ['postgres', 'mariadb'].includes(e),
  consistentCopy: (e: string) => e === 'redis',
};

const app = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  slug: id,
  clusterId: 'c1',
  kind: 'APPLICATION',
  category: 'user',
  status: 'running',
  systemProtected: false,
  preDeploySnapshotEnabled: false,
  volumes: [{ name: 'data' }],
  labels: {},
  ...over,
});

function build(opts: {
  apps: any[];
  policies?: any[];
  protection?: Record<string, unknown> | null;
  locked?: boolean;
  destinationOwner?: string;
}) {
  const row =
    opts.protection === null
      ? null
      : {
          id: 'prot-1',
          clusterId: 'c1',
          userId: 'u1',
          destinationId: 'd1',
          replicaDestinationId: null,
          cronSchedule: null,
          retentionDays: 30,
          beforeDeploy: false,
          applications: {},
          ...opts.protection,
        };
  const protections = {
    findOne: jest.fn(async () => row),
    find: jest.fn(async () => (row ? [row] : [])),
    create: jest.fn((x) => ({ ...x })),
    save: jest.fn(async (x) => ({ id: 'prot-1', ...x })),
    update: jest.fn(async () => undefined),
    delete: jest.fn(async () => ({ affected: row ? 1 : 0 })),
  };
  const apps = {
    find: jest.fn(async () => opts.apps),
    findOne: jest.fn(async ({ where }: any) =>
      opts.apps.find((a) => a.id === where.id),
    ),
    update: jest.fn(async () => undefined),
  };
  const policies = {
    enableDatabase: jest.fn(
      async (_u: string, dto: any, _d: any, engine: string) => ({
        id: `db-${dto.scopeSelector.applicationIds[0]}`,
        engine,
      }),
    ),
    create: jest.fn(async (_u: string, dto: any) => ({
      id: `vc-${dto.scopeSelector.applicationIds[0]}`,
    })),
  };
  const jobs = { createOnDemand: jest.fn(async () => ({ id: 'job' })) };
  const runner = {
    connect: jest.fn(),
    release: jest.fn(),
    query: jest.fn(async (sql: string) =>
      sql.includes('try_advisory') ? [{ locked: opts.locked ?? true }] : [],
    ),
  };
  const queue = { add: jest.fn(async () => undefined) };
  const ops = {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'op-1', ...x })),
  };
  const placement = { assertOffProvider: jest.fn(async () => undefined) };
  const service = new ClusterProtectionService(
    protections as any,
    { findOne: jest.fn(async () => ({ id: 'c1', status: 'ready' })) } as any,
    apps as any,
    { find: jest.fn(async () => opts.policies ?? []) } as any,
    ops as any,
    {
      findById: jest.fn(async (id: string) => ({
        id,
        userId: opts.destinationOwner ?? 'u1',
      })),
    } as any,
    policies as any,
    jobs as any,
    placement as any,
    { resolveForApp: jest.fn(async () => undefined) } as any,
    {
      support: () => support,
      forCluster: jest.fn(async () => []),
    } as any,
    { createQueryRunner: () => runner } as any,
    queue as any,
  );
  return {
    service,
    protections,
    apps,
    policies,
    jobs,
    runner,
    queue,
    placement,
  };
}

describe('protecting a cluster gives every application a policy of its own', () => {
  it('uses the database engine for a recognised database and volume copies for the rest', async () => {
    const { service, policies, jobs, protections } = build({
      apps: [
        app('pg', {
          kind: 'DATABASE',
          labels: { 'flui.cloud/db-engine': 'postgres' },
        }),
        app('web'),
        app('static', { volumes: [] }),
        app('mongo', { labels: { 'flui.cloud/db-engine': 'mongodb' } }),
      ],
    });
    const result = await service.reconcile('c1', { runFirstBackup: true });

    expect(policies.enableDatabase).toHaveBeenCalledTimes(1);
    const [, dbDto, , engine] = policies.enableDatabase.mock.calls[0];
    expect(engine).toBe('postgres');
    expect(dbDto).toMatchObject({
      engineClass: BackupEngineClass.DATABASE,
      scopeSelector: { applicationIds: ['pg'] },
    });
    expect(dbDto.cronSchedule).toBeUndefined();

    expect(policies.create).toHaveBeenCalledTimes(1);
    const [, copyDto] = policies.create.mock.calls[0];
    expect(copyDto).toMatchObject({
      engineClass: BackupEngineClass.VOLUME_COPY,
      scopeSelector: { applicationIds: ['web'] },
      destinations: [{ destinationId: 'd1', role: DestinationRole.PRIMARY }],
    });
    expect(copyDto.engineClass).not.toBe('volume');
    // First base of the database, first copy of the volumes.
    expect(jobs.createOnDemand).toHaveBeenCalledTimes(2);

    const byApp = Object.fromEntries(
      result!.applications.map((a) => [a.applicationId, a.outcome]),
    );
    expect(byApp).toEqual({
      pg: 'protected',
      web: 'protected',
      static: 'skipped',
      mongo: 'needs_decision',
    });
    expect(protections.update).toHaveBeenCalledWith(
      'prot-1',
      expect.objectContaining({ applications: expect.any(Object) }),
    );
  });

  it('adds nothing to an application a policy already covers', async () => {
    const { service, policies } = build({
      apps: [app('web')],
      policies: [
        {
          engineClass: BackupEngineClass.VOLUME_COPY,
          scopeSelector: { applicationIds: ['web'] },
        },
      ],
    });
    const result = await service.reconcile('c1');
    expect(policies.create).not.toHaveBeenCalled();
    expect(result!.applications[0].outcome).toBe('already_protected');
  });

  it('waits for a database that is not running instead of failing it', async () => {
    const { service, policies } = build({
      apps: [
        app('pg', {
          status: 'provisioning',
          labels: { 'flui.cloud/db-engine': 'postgres' },
        }),
      ],
    });
    const result = await service.reconcile('c1');
    expect(policies.enableDatabase).not.toHaveBeenCalled();
    expect(result!.applications[0].outcome).toBe('waiting');
  });

  it('records a failure and leaves it to a later pass rather than retrying every sweep', async () => {
    const recent = new Date().toISOString();
    const { service, policies } = build({
      apps: [app('web')],
      protection: {
        applications: { web: { outcome: 'failed', reason: 'x', at: recent } },
      },
    });
    await service.reconcile('c1');
    expect(policies.create).not.toHaveBeenCalled();
    await service.reconcile('c1', { onlyAppIds: ['web'] });
    expect(policies.create).toHaveBeenCalledTimes(1);
  });

  it('gives no policy to an application a person decided not to back up, even after a recent failure', async () => {
    const decided = {
      backupDecision: {
        notBackedUp: true,
        decidedBy: 'u1',
        decidedAt: new Date().toISOString(),
      },
    };
    const { service, policies, jobs } = build({
      apps: [
        app('pg', {
          ...decided,
          kind: 'DATABASE',
          labels: { 'flui.cloud/db-engine': 'postgres' },
        }),
        app('web', decided),
      ],
      protection: {
        applications: {
          web: { outcome: 'failed', reason: 'x', at: new Date().toISOString() },
        },
      },
    });
    const result = await service.reconcile('c1', { runFirstBackup: true });
    expect(policies.enableDatabase).not.toHaveBeenCalled();
    expect(policies.create).not.toHaveBeenCalled();
    expect(jobs.createOnDemand).not.toHaveBeenCalled();
    expect(
      result!.applications.map((a) => [a.applicationId, a.outcome, a.reason]),
    ).toEqual([
      ['pg', 'skipped', 'not_backed_up_by_choice'],
      ['web', 'skipped', 'not_backed_up_by_choice'],
    ]);
  });

  it('does nothing while another pass holds the cluster', async () => {
    const { service, policies, runner } = build({
      apps: [app('web')],
      locked: false,
    });
    expect(await service.reconcile('c1')).toBeNull();
    expect(policies.create).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('does nothing on a cluster that is not protected', async () => {
    const { service, policies } = build({
      apps: [app('web')],
      protection: null,
    });
    expect(await service.reconcile('c1')).toBeNull();
    expect(policies.create).not.toHaveBeenCalled();
  });

  it('turns on the backup before each deploy when the protection asks for it', async () => {
    const { service, apps } = build({
      apps: [app('web')],
      protection: { beforeDeploy: true },
    });
    await service.reconcile('c1');
    expect(apps.update).toHaveBeenCalledWith('web', {
      preDeploySnapshotEnabled: true,
    });
  });

  it('refuses a destination that belongs to somebody else before recording anything', async () => {
    const { service, protections, queue } = build({
      apps: [],
      destinationOwner: 'someone-else',
    });
    await expect(
      service.start('u1', 'c1', { destinationId: 'd1' }),
    ).rejects.toThrow('Destination d1 not found');
    expect(protections.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('records the promise and queues the first pass as an operation', async () => {
    const { service, protections, queue, placement } = build({ apps: [] });
    const { operationId } = await service.start('u1', 'c1', {
      destinationId: 'd1',
      beforeDeploy: true,
    });
    expect(operationId).toBe('op-1');
    expect(placement.assertOffProvider).toHaveBeenCalledWith('c1', 'd1');
    expect(protections.save).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: 'd1', beforeDeploy: true }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'protect-cluster',
      { clusterId: 'c1', operationId: 'op-1', runFirstBackup: true },
      expect.any(Object),
    );
  });
});
