import { DbMigrationEntity } from '../entities/db-migration.entity';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { DbMigrationStatus } from '../enums/db-migration.enum';
import {
  DbReplicationKind,
  DbReplicationStatus,
} from '../enums/db-replication-status.enum';
import {
  WireGuardLinkEntity,
  WireGuardLinkState,
} from '../../infrastructure/networking/entities/wireguard-link.entity';
import {
  baseBackupView,
  dbMigrationView,
  dbNextSteps,
  fenceAppliedAt,
  pauseMs,
} from './db-migration-view';

const mig = (over: Partial<DbMigrationEntity> = {}): DbMigrationEntity =>
  ({
    id: 'm1',
    srcAppId: 'src',
    dstAppId: 'dst',
    kind: DbReplicationKind.PHYSICAL,
    status: DbMigrationStatus.SYNCED,
    linkId: 'l1',
    ...over,
  }) as DbMigrationEntity;

const wg = (over: Partial<WireGuardLinkEntity> = {}): WireGuardLinkEntity =>
  ({
    id: 'wg1',
    state: WireGuardLinkState.OPEN,
    listenerNodeId: 'node-a',
    dialerNodeId: 'node-b',
    lastHandshakeAt: new Date('2026-10-11T10:00:00Z'),
    openedAt: new Date('2026-10-11T09:59:00Z'),
    closedAt: null,
    ...over,
  }) as WireGuardLinkEntity;

describe('pauseMs', () => {
  it('measures from the first instant to the second', () => {
    expect(
      pauseMs('2026-10-11T10:00:00.000Z', new Date('2026-10-11T10:00:04.250Z')),
    ).toBe(4250);
  });

  it('gives nothing when an end is missing, malformed or before the start', () => {
    expect(pauseMs(null, new Date())).toBeNull();
    expect(pauseMs('now', new Date())).toBeNull();
    expect(pauseMs('2026-10-11T10:00:05Z', '2026-10-11T10:00:00Z')).toBeNull();
  });

  it('reads the fence start back from the record', () => {
    expect(
      fenceAppliedAt({ appliedAt: '2026-10-11T10:00:00.000Z' } as never),
    ).toEqual(new Date('2026-10-11T10:00:00.000Z'));
    expect(fenceAppliedAt({ appliedAt: 'now' } as never)).toBeNull();
    expect(fenceAppliedAt(null)).toBeNull();
  });
});

describe('dbMigrationView', () => {
  it('shows the direct link with node names and whether a handshake was seen', () => {
    const view = dbMigrationView(mig(), {
      repl: { status: DbReplicationStatus.COPYING } as DbReplicationLinkEntity,
      wg: wg(),
      nodeNames: new Map([
        ['node-a', 'hz-db-1'],
        ['node-b', 'scw-master'],
      ]),
    });
    expect(view.link).toEqual({
      state: 'open',
      listenerNode: 'hz-db-1',
      dialerNode: 'scw-master',
      handshakeSeen: true,
      lastHandshakeAt: '2026-10-11T10:00:00.000Z',
      openedAt: '2026-10-11T09:59:00.000Z',
      closedAt: null,
    });
    expect(
      dbMigrationView(mig(), { wg: wg({ lastHandshakeAt: null }) }).link
        ?.handshakeSeen,
    ).toBe(false);
  });

  it('summarises the fence instead of the raw record', () => {
    const view = dbMigrationView(
      mig({
        fence: {
          method: 'pg_hba',
          marker: 'flui:fence:x',
          hbaSha256Before: 'abc',
          appliedAt: '2026-10-11T10:00:00.000Z',
          fenceLsn: '0/5A000110',
          promoteIssuedAt: '2026-10-11T10:00:03.000Z',
          releasedAt: null,
        },
      }),
    );
    expect(view.fence).toEqual({
      appliedAt: '2026-10-11T10:00:00.000Z',
      fenceLsn: '0/5A000110',
      terminatedSessions: null,
      promoteIssuedAt: '2026-10-11T10:00:03.000Z',
      released: false,
      releasedAt: null,
      releaseNote: null,
    });
    expect(JSON.stringify(view)).not.toContain('hbaSha256Before');
  });

  it('gives a logical migration no link, fence or copy phase', () => {
    const view = dbMigrationView(mig({ kind: DbReplicationKind.LOGICAL }), {
      repl: {
        status: DbReplicationStatus.STREAMING,
      } as DbReplicationLinkEntity,
    });
    expect(view.kind).toBe('logical');
    expect(view.link).toBeNull();
    expect(view.fence).toBeNull();
    expect(view.baseBackup).toBeNull();
    expect(view.sourceWalCap).toBeNull();
  });

  it('says the WAL cap Flui put on the source and that it is cluster-wide', () => {
    const view = dbMigrationView(mig(), {
      repl: {
        status: DbReplicationStatus.STREAMING,
        transport: { walKeepSet: '2048MB', walKeepNote: 'Caps every slot.' },
      } as unknown as DbReplicationLinkEntity,
    });
    expect(view.sourceWalCap).toEqual({
      value: '2048MB',
      note: 'Caps every slot.',
    });
  });

  it('stops showing the WAL cap once the migration has ended and reset it', () => {
    const view = dbMigrationView(mig({ status: DbMigrationStatus.COMPLETED }), {
      repl: {
        status: DbReplicationStatus.STREAMING,
        transport: { walKeepSet: '2048MB', walKeepNote: 'Caps every slot.' },
      } as unknown as DbReplicationLinkEntity,
    });
    expect(view.sourceWalCap).toBeNull();
  });
});

describe('baseBackupView', () => {
  it('names the copy phase from the replication link', () => {
    const phase = (status: DbReplicationStatus) =>
      baseBackupView({ status } as DbReplicationLinkEntity)?.phase;
    expect(phase(DbReplicationStatus.INIT)).toBe('waiting');
    expect(phase(DbReplicationStatus.COPYING)).toBe('copying');
    expect(phase(DbReplicationStatus.STREAMING)).toBe('done');
    expect(phase(DbReplicationStatus.PROMOTED)).toBe('done');
    expect(phase(DbReplicationStatus.FAILED)).toBe('failed');
    expect(baseBackupView(null)).toBeNull();
  });

  it('reports the replay lag only while streaming', () => {
    expect(
      baseBackupView({
        status: DbReplicationStatus.STREAMING,
        lagBytes: '2048',
      } as DbReplicationLinkEntity),
    ).toEqual({ phase: 'done', lagBytes: 2048 });
    expect(
      baseBackupView({
        status: DbReplicationStatus.PROMOTED,
        lagBytes: '0',
      } as DbReplicationLinkEntity)?.lagBytes,
    ).toBeNull();
  });
});

describe('dbNextSteps', () => {
  it('asks to protect the new database and repoint its users once completed', () => {
    expect(
      dbNextSteps(mig({ status: DbMigrationStatus.COMPLETED })).map(
        (s) => s.key,
      ),
    ).toEqual(['protect-database', 'repoint-consumers']);
    expect(
      dbNextSteps(mig({ status: DbMigrationStatus.COMPLETED }))[0].text,
    ).toContain('(dst) with a backup policy');
  });

  it('leaves the repointing to the full migration that owns the leg', () => {
    expect(
      dbNextSteps(
        mig({ status: DbMigrationStatus.COMPLETED, fullMigrationId: 'fm1' }),
      ).map((s) => s.key),
    ).toEqual(['protect-database']);
  });

  it('has nothing to suggest before completion', () => {
    expect(dbNextSteps(mig({ status: DbMigrationStatus.CUTOVER }))).toEqual([]);
  });
});

describe('the pooler block', () => {
  const plan = {
    poolers: [
      { appId: 'src', role: 'source' as const },
      { appId: 'dst', role: 'destination' as const },
    ],
    deadlineMs: 5000,
  };

  it('is absent without a pooler cut, and the raw record never reaches the view', () => {
    const view = dbMigrationView(mig());
    expect(view.pooler).toBeNull();
    expect('poolerCut' in view).toBe(false);
  });

  it('says whether the poolers still hold writes and who was cut, without addresses or pids', () => {
    const view = dbMigrationView(
      mig({
        poolerCut: {
          ...plan,
          pausedAt: '2026-10-12T10:00:00.000Z',
          resumedAt: '2026-10-12T10:00:08.000Z',
          resumedBy: 'retarget',
          sourceLeftPaused: true,
          cut: [
            {
              pod: 'pg-b-pooler-1',
              role: 'destination',
              remotePid: 4242,
              clientId: 17,
              user: 'app',
              database: 'app_db',
              clientAddr: '10.42.1.7',
              clientApp: 'worker',
              heldMs: 6100,
            },
          ],
        },
      }),
    );
    expect(view.pooler).toEqual({
      paused: false,
      pausedAt: '2026-10-12T10:00:00.000Z',
      resumedAt: '2026-10-12T10:00:08.000Z',
      resumedBy: 'retarget',
      sourceLeftPaused: true,
      deadlineMs: 5000,
      cut: [{ clientApp: 'worker', heldMs: 6100 }],
    });
    expect(
      dbMigrationView(
        mig({ poolerCut: { ...plan, pausedAt: '2026-10-12T10:00:00.000Z' } }),
      ).pooler?.paused,
    ).toBe(true);
  });

  it('reads a pause a rollback or an abort ended as over, and says who ended it', () => {
    for (const by of ['rollback', 'abort'] as const) {
      const pooler = dbMigrationView(
        mig({
          status: DbMigrationStatus.SYNCED,
          poolerCut: {
            ...plan,
            pausedAt: '2026-10-12T10:00:00.000Z',
            resumedAt: '2026-10-12T10:00:03.000Z',
            resumedBy: by,
          },
        }),
      ).pooler;
      expect(pooler).toMatchObject({
        paused: false,
        resumedBy: by,
        sourceLeftPaused: false,
      });
    }
  });
});
