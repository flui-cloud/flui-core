jest.mock('@kubernetes/client-node', () => ({}));

import { DbMigrationService, replicationKindFor } from './db-migration.service';
import { DbMigrationMode, DbMigrationStatus } from '../enums/db-migration.enum';
import { DbReplicationKind } from '../enums/db-replication-status.enum';

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && '_type' in v) {
      if (v._type === 'in') return v._value.includes(row[k]);
      if (v._type === 'raw') return !row[k]?.promoteIssuedAt;
    }
    return row[k] === v;
  });
}

function setup(
  mig: Record<string, any>,
  recovery = 'standby',
  poolerCut?: Record<string, any>,
) {
  const calls: string[] = [];
  const row: any = {
    id: 'm1',
    srcAppId: 'src',
    linkId: 'l1',
    kind: DbReplicationKind.PHYSICAL,
    ...mig,
  };
  const migRepo = {
    findOne: jest.fn(async () => ({ ...row })),
    save: jest.fn(async (m: any) => Object.assign(row, m)),
    update: jest.fn(async (criteria: any, partial: any) => {
      if (typeof criteria === 'string') {
        Object.assign(row, partial);
        return { affected: 1 };
      }
      const list = Array.isArray(criteria) ? criteria : [criteria];
      if (!list.some((c) => matches(row, c))) return { affected: 0 };
      Object.assign(row, partial);
      return { affected: 1 };
    }),
  };
  const physical = {
    getLink: jest.fn(async () => ({ id: 'l1', dstAppId: 'dst' })),
    recoveryState: jest.fn(async () => recovery),
    abort: jest.fn(async () => {
      calls.push('link-abort');
      return { notes: [] };
    }),
  };
  const fence = {
    unfence: jest.fn(async (_t: any, r: any) => {
      calls.push('unfence');
      return { ...r, releasedAt: 'now', releaseNote: null };
    }),
  };
  const exec = {
    resolve: jest.fn(async (id: string) => ({ appId: id })),
    execRaw: jest.fn(async (_t: any, c: string) => {
      calls.push(`raw:${c}`);
      return '';
    }),
  };
  const svc = new DbMigrationService(
    migRepo as any,
    {} as any,
    {} as any,
    { update: jest.fn() } as any,
    { add: jest.fn() } as any,
    {} as any,
    physical as any,
    fence as any,
    exec as any,
    {} as any,
    poolerCut as any,
  );
  (svc as any).findById = jest.fn(async () => ({ ...row }));
  return { svc, row, calls, physical };
}

const fenced = {
  method: 'pg_hba',
  marker: 'flui:fence:0123456789ab',
  hbaSha256Before: 'h0',
  appliedAt: 'then',
  releasedAt: null,
};

describe('replicationKindFor', () => {
  afterEach(() => {
    delete process.env.FLUI_DB_MIGRATION_TRANSPORT;
    process.env.FLUI_WG_ENABLED = 'false';
  });

  it('replicates physically to another cluster over the Flui network', () => {
    process.env.FLUI_WG_ENABLED = 'true';
    expect(replicationKindFor(DbMigrationMode.LIVE, 'a', 'b')).toBe(
      DbReplicationKind.PHYSICAL,
    );
  });

  it.each([
    ['same cluster', DbMigrationMode.LIVE, 'a', 'a', 'true', undefined],
    ['restore mode', DbMigrationMode.RESTORE, 'a', 'b', 'true', undefined],
    ['network off', DbMigrationMode.LIVE, 'a', 'b', 'false', undefined],
    ['forced logical', DbMigrationMode.LIVE, 'a', 'b', 'true', 'logical'],
  ])('stays logical: %s', (_l, mode, from, to, wg, forced) => {
    process.env.FLUI_WG_ENABLED = wg as string;
    if (forced) process.env.FLUI_DB_MIGRATION_TRANSPORT = forced;
    expect(replicationKindFor(mode, from, to)).toBe(DbReplicationKind.LOGICAL);
  });
});

describe('DbMigrationService.abort, physical', () => {
  it('undoes the fence and tears the link down before promote was asked', async () => {
    const { svc, row, calls } = setup({
      status: DbMigrationStatus.CUTOVER,
      fence: fenced,
    });
    await svc.abort('m1');
    expect(calls).toEqual(['unfence', 'link-abort']);
    expect(row.status).toBe(DbMigrationStatus.ABORTED);
    expect(row.fence.releasedAt).toBe('now');
  });

  it('aborts a replicating migration without touching a fence it never set', async () => {
    const { svc, row, calls } = setup({
      status: DbMigrationStatus.REPLICATING,
    });
    await svc.abort('m1');
    expect(calls).toEqual(['link-abort']);
    expect(row.status).toBe(DbMigrationStatus.ABORTED);
  });

  it.each([
    ['primary', /already promoted/],
    ['unknown', /cannot be queried/],
  ])(
    'refuses once promote was asked and the destination is %s, leaving the source fenced',
    async (state, message) => {
      const { svc, row, calls } = setup(
        {
          status: DbMigrationStatus.CUTOVER,
          fence: { ...fenced, promoteIssuedAt: 'now' },
        },
        state,
      );
      await expect(svc.abort('m1')).rejects.toThrow(message);
      expect(calls).toEqual([]);
      expect(row.status).toBe(DbMigrationStatus.CUTOVER);
    },
  );

  it('refuses once promote was asked even while the destination is still a standby: it completes forward', async () => {
    const { svc, row, calls } = setup({
      status: DbMigrationStatus.CUTOVER,
      fence: { ...fenced, promoteIssuedAt: 'now' },
    });
    await expect(svc.abort('m1')).rejects.toThrow(/completes forward/);
    expect(calls).toEqual([]);
    expect(row.status).toBe(DbMigrationStatus.CUTOVER);
  });

  it('refuses a completed migration', async () => {
    const { svc } = setup({ status: DbMigrationStatus.COMPLETED });
    await expect(svc.abort('m1')).rejects.toThrow(/cannot be aborted/);
  });
});

describe('DbMigrationService.create, physical', () => {
  afterEach(() => {
    process.env.FLUI_WG_ENABLED = 'false';
  });

  const build = (assertTargetReady: jest.Mock) => {
    const op = {
      save: jest.fn(async (x: any) => ({ ...x, id: 'op1' })),
      create: (x: any) => x,
    };
    const migRepo = {
      findOne: jest.fn(async () => null),
      save: jest.fn(async (x: any) => ({ ...x, id: 'm1' })),
      create: (x: any) => x,
    };
    const queue = { add: jest.fn() };
    const svc = new DbMigrationService(
      migRepo as any,
      {
        findOne: jest.fn(async () => ({
          id: 'src',
          clusterId: 'a',
          slug: 'pg',
        })),
      } as any,
      { findOne: jest.fn(async () => ({ id: 'b' })) } as any,
      op as any,
      queue as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { assertTargetReady } as any,
    );
    return { svc, queue, op };
  };

  it('refuses before anything is installed when the destination node is not on the Flui network', async () => {
    process.env.FLUI_WG_ENABLED = 'true';
    const { svc, queue, op } = build(
      jest.fn(async () => {
        throw new Error(
          'node b-master of cluster b is not live on the Flui network',
        );
      }),
    );
    await expect(
      svc.create('u1', { srcAppId: 'src', targetClusterId: 'b' } as any),
    ).rejects.toThrow(/not live on the Flui network/);
    expect(op.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not ask a logical migration about the Flui network', async () => {
    process.env.FLUI_WG_ENABLED = 'false';
    const assertTargetReady = jest.fn();
    const { svc, queue } = build(assertTargetReady);
    await svc.create('u1', { srcAppId: 'src', targetClusterId: 'b' } as any);
    expect(assertTargetReady).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
  });
});

describe('DbMigrationService.abort with paused poolers', () => {
  const paused = {
    poolers: [
      { appId: 'src', role: 'source' },
      { appId: 'dst', role: 'destination' },
    ],
    deadlineMs: 5000,
    pausedPods: [{ appId: 'src', pod: 'pg-a-pooler-1' }],
    pausedAt: 'then',
  };

  it('lifts the fence, then lets both poolers through, before promote', async () => {
    const cut = {
      resumeRoles: jest.fn(async (_m: any, roles: string[], by: string) => {
        calls.push(`resume:${roles.join('+')}:${by}`);
        return [];
      }),
    };
    const { svc, row, calls } = setup(
      {
        status: DbMigrationStatus.CUTOVER,
        fence: fenced,
        poolerCut: paused,
      },
      'standby',
      cut,
    );
    await svc.abort('m1');
    expect(row.status).toBe(DbMigrationStatus.ABORTED);
    expect(calls[0]).toBe('unfence');
    expect(calls).toContain('resume:source+destination:abort');
  });

  it('leaves poolers that were already resumed alone', async () => {
    const cut = { resumeRoles: jest.fn(async () => []) };
    const { svc } = setup(
      {
        status: DbMigrationStatus.SYNCED,
        poolerCut: { ...paused, resumedAt: 'later' },
      },
      'standby',
      cut,
    );
    await svc.abort('m1');
    expect(cut.resumeRoles).not.toHaveBeenCalled();
  });
});
