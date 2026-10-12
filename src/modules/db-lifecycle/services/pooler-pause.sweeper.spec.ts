jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { PoolerPauseSweeper } from './pooler-pause.sweeper';
import { DbMigrationStatus } from '../enums/db-migration.enum';
import { FullMigrationStatus } from '../../full-migration/enums/full-migration.enum';

const pooler = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  upstream: { mode: 'local' },
  ...extra,
});

function setup(opts: {
  apps: any[];
  busy?: Array<{
    srcAppId: string;
    dstAppId: string;
    status: DbMigrationStatus;
    fullMigrationId?: string;
  }>;
  paused?: string[];
  parents?: Array<{ id: string; status: FullMigrationStatus }>;
}) {
  const migRepo = {
    find: jest
      .fn()
      .mockResolvedValueOnce([
        {
          poolerCut: {
            poolers: [
              { appId: 'src', role: 'source' },
              { appId: 'dst', role: 'destination' },
            ],
          },
        },
      ])
      .mockResolvedValueOnce(opts.busy ?? []),
  };
  const apps = { find: jest.fn(async () => opts.apps) };
  const cut = {
    pausedPods: jest.fn(async (id: string) =>
      (opts.paused ?? []).includes(id) ? [`${id}-pooler-1`] : [],
    ),
    release: jest.fn(async (id: string) => [`${id}-pooler-1`]),
  };
  const fullRepo = {
    find: jest.fn(async ({ where }: any) =>
      (opts.parents ?? []).filter(
        (p) =>
          where.id.value.includes(p.id) &&
          where.status.value.includes(p.status),
      ),
    ),
  };
  const sweeper = new PoolerPauseSweeper(
    migRepo as any,
    apps as any,
    cut as any,
    fullRepo as any,
  );
  return { sweeper, cut, fullRepo };
}

describe('PoolerPauseSweeper', () => {
  it('resumes a pooler left paused outside a cutover', async () => {
    const { sweeper, cut } = setup({
      apps: [{ id: 'dst', slug: 'pg-b', pooler: pooler() }],
      paused: ['dst'],
    });
    expect(await sweeper.sweep()).toEqual(['dst']);
    expect(cut.release).toHaveBeenCalledWith('dst', { retarget: false });
  });

  it('leaves the suspended source and a pooler whose migration is cutting over alone', async () => {
    const { sweeper, cut } = setup({
      apps: [
        { id: 'src', slug: 'pg-a', pooler: pooler({ suspended: true }) },
        { id: 'dst', slug: 'pg-b', pooler: pooler() },
      ],
      busy: [
        { srcAppId: 'x', dstAppId: 'dst', status: DbMigrationStatus.CUTOVER },
      ],
      paused: ['src', 'dst'],
    });
    expect(await sweeper.sweep()).toEqual([]);
    expect(cut.release).not.toHaveBeenCalled();
  });

  it('keeps a forward while its migration is synced, and retargets one left behind', async () => {
    const forwarding = pooler({ upstream: { mode: 'forward' } });
    const held = setup({
      apps: [{ id: 'dst', slug: 'pg-b', pooler: forwarding }],
      busy: [
        { srcAppId: 'src', dstAppId: 'dst', status: DbMigrationStatus.SYNCED },
      ],
    });
    expect(await held.sweeper.sweep()).toEqual([]);

    const left = setup({
      apps: [{ id: 'dst', slug: 'pg-b', pooler: forwarding }],
    });
    expect(await left.sweeper.sweep()).toEqual(['dst']);
    expect(left.cut.release).toHaveBeenCalledWith('dst', { retarget: true });
  });

  it('leaves the poolers of a synced leg alone while its full migration cuts over or bridges', async () => {
    for (const status of [
      FullMigrationStatus.CUTOVER,
      FullMigrationStatus.BRIDGING,
    ]) {
      const { sweeper, cut } = setup({
        apps: [
          { id: 'src', slug: 'pg-a', pooler: pooler() },
          { id: 'dst', slug: 'pg-b', pooler: pooler() },
        ],
        busy: [
          {
            srcAppId: 'src',
            dstAppId: 'dst',
            status: DbMigrationStatus.SYNCED,
            fullMigrationId: 'fm1',
          },
        ],
        parents: [{ id: 'fm1', status }],
        paused: ['src', 'dst'],
      });
      expect(await sweeper.sweep()).toEqual([]);
      expect(cut.pausedPods).not.toHaveBeenCalled();
    }
  });

  it('still resumes a synced leg whose full migration is back to ready', async () => {
    const { sweeper } = setup({
      apps: [{ id: 'dst', slug: 'pg-b', pooler: pooler() }],
      busy: [
        {
          srcAppId: 'src',
          dstAppId: 'dst',
          status: DbMigrationStatus.SYNCED,
          fullMigrationId: 'fm1',
        },
      ],
      parents: [{ id: 'fm1', status: FullMigrationStatus.READY }],
      paused: ['dst'],
    });
    expect(await sweeper.sweep()).toEqual(['dst']);
  });
});
