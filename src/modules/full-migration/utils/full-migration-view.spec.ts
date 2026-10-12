import { FullMigrationStatus } from '../enums/full-migration.enum';
import {
  fullMigrationReadView,
  fullNextSteps,
  fullWritePause,
} from './full-migration-view';

const FENCED = '2026-10-11T10:00:00.000Z';

describe('fullWritePause', () => {
  it('ends at the bridge activation when the source forwards', () => {
    expect(
      fullWritePause(
        { writesStoppedAt: new Date(FENCED), fence: null },
        {
          bridgeState: {
            mode: 'bridge',
            state: 'active',
            activatedAt: '2026-10-11T10:00:06.500Z',
            dnsFlippedAt: '2026-10-11T10:00:40.000Z',
          } as never,
          dnsFlippedAt: new Date('2026-10-11T10:00:40.000Z'),
        },
      ),
    ).toEqual({ writePauseMs: 6500, writePauseEndedBy: 'bridge' });
  });

  it('ends at the DNS switch without a bridge', () => {
    expect(
      fullWritePause(
        { writesStoppedAt: null, fence: { appliedAt: FENCED } as never },
        {
          bridgeState: {
            mode: 'dns-only',
            skipReason: 'no certificate',
          } as never,
          dnsFlippedAt: new Date('2026-10-11T10:00:12.000Z'),
        },
      ),
    ).toEqual({ writePauseMs: 12000, writePauseEndedBy: 'dns' });
  });

  it('stays unknown when either end was not recorded', () => {
    const none = { writePauseMs: null, writePauseEndedBy: null };
    expect(
      fullWritePause(
        { writesStoppedAt: null, fence: null },
        { bridgeState: null, dnsFlippedAt: new Date() },
      ),
    ).toEqual(none);
    expect(
      fullWritePause(
        { writesStoppedAt: new Date(FENCED), fence: null },
        { bridgeState: null, dnsFlippedAt: null },
      ),
    ).toEqual(none);
    expect(fullWritePause(null, null)).toEqual(none);
  });
});

describe('fullNextSteps', () => {
  it('asks to protect the new database and to destroy a source still standing', () => {
    const steps = fullNextSteps(
      { status: FullMigrationStatus.COMPLETED },
      { dstAppId: 'db-new' },
      { sourceDestroyedAt: undefined },
    );
    expect(steps.map((s) => s.key)).toEqual([
      'protect-database',
      'destroy-source',
    ]);
    expect(steps[0].text).toContain('backup policy');
  });

  it('only asks for the backup once the source is gone', () => {
    expect(
      fullNextSteps(
        { status: FullMigrationStatus.COMPLETED },
        { dstAppId: 'db-new' },
        { sourceDestroyedAt: new Date() },
      ).map((s) => s.key),
    ).toEqual(['protect-database']);
  });

  it('suggests nothing before completion', () => {
    expect(
      fullNextSteps(
        { status: FullMigrationStatus.BRIDGING },
        { dstAppId: 'db-new' },
        null,
      ),
    ).toEqual([]);
  });
});

describe('fullMigrationReadView', () => {
  it("carries the database leg's link and fence, and the app leg's interruption", () => {
    const view = fullMigrationReadView(
      {
        id: 'fm1',
        status: FullMigrationStatus.CUTOVER,
        bridge: null,
        writePauseMs: null,
      } as never,
      {
        id: 'dbm1',
        kind: 'physical',
        link: { state: 'open', handshakeSeen: true },
        fence: { appliedAt: FENCED, released: false },
        baseBackup: { phase: 'done', lagBytes: 0 },
        pooler: {
          paused: true,
          pausedAt: FENCED,
          resumedAt: null,
          deadlineMs: 5000,
          cut: [],
        },
      } as never,
      { id: 'am1', interruptionMs: 42_000 } as never,
    );
    expect(view.pooler).toEqual({
      paused: true,
      pausedAt: FENCED,
      resumedAt: null,
      deadlineMs: 5000,
      cut: [],
    });
    expect(view.kind).toBe('physical');
    expect(view.link).toEqual({ state: 'open', handshakeSeen: true });
    expect(view.fence).toEqual({ appliedAt: FENCED, released: false });
    expect(view.baseBackup).toEqual({ phase: 'done', lagBytes: 0 });
    expect(view.interruptionMs).toBe(42_000);
    expect(view.writePauseMs).toBeNull();
    expect(view.writePauseEndedBy).toBeNull();
  });
});

describe('fullWritePause with the poolers holding writes', () => {
  it('runs from the pause to the destination pooler resume, ended by the resume', () => {
    expect(
      fullWritePause(
        {
          writesStoppedAt: new Date('2026-10-11T10:00:00.000Z'),
          fence: { appliedAt: '2026-10-11T10:00:05.000Z' } as never,
          promoteConfirmedAt: new Date('2026-10-11T10:00:07.000Z'),
          poolerCut: {
            poolers: [],
            deadlineMs: 5000,
            pausedAt: '2026-10-11T10:00:00.000Z',
            resumedAt: '2026-10-11T10:00:08.200Z',
          },
        },
        {
          bridgeState: {
            mode: 'bridge',
            state: 'active',
            activatedAt: '2026-10-11T09:59:00.000Z',
          } as never,
          dnsFlippedAt: null as never,
        },
      ),
    ).toEqual({ writePauseMs: 8200, writePauseEndedBy: 'resume' });
  });
});
