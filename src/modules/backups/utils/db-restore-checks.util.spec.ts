import {
  assertRestoreAwareManifest,
  assertTargetWithinWindow,
  parseNewestArchived,
} from './db-restore-checks.util';

const engine = {
  engine: 'postgres',
  catalogSlug: 'postgresql',
  restoreEnvPrefix: 'FLUI_PG_',
};

describe('db restore checks', () => {
  it('compares a target only against a window that is an instant', () => {
    const at = new Date('2026-09-26T21:00:00Z');
    expect(assertTargetWithinWindow(at, null)).toBe(true);
    expect(assertTargetWithinWindow(at, 'base-20260926T2100')).toBe(false);
    expect(assertTargetWithinWindow(at, '2026-09-26T20:00:00Z')).toBe(true);
    expect(() => assertTargetWithinWindow(at, '2026-09-26T22:00:00Z')).toThrow(
      /precedes the oldest recoverable point/,
    );
  });

  it('reads the newest archived change only when it is a moment', () => {
    expect(parseNewestArchived(undefined)).toBeNull();
    expect(parseNewestArchived('not a date')).toBeNull();
    expect(parseNewestArchived('2026-09-26T21:22:36.000Z')?.toISOString()).toBe(
      '2026-09-26T21:22:36.000Z',
    );
  });

  it('refuses a catalog app that would drop the restore environment', () => {
    expect(() => assertRestoreAwareManifest(null, engine, [])).toThrow(
      /is not published/,
    );
    expect(() =>
      assertRestoreAwareManifest({ manifest: undefined }, engine, []),
    ).toThrow(/does not declare FLUI_PG_RESTORE/);
    const declared = {
      manifest: { spec: { env: [{ name: 'FLUI_PG_RESTORE' }] } },
    };
    expect(() =>
      assertRestoreAwareManifest(declared, engine, [
        'FLUI_PG_RESTORE',
        'FLUI_PG_CIPHER_PASS',
        'POSTGRES_USER',
      ]),
    ).toThrow(/does not declare FLUI_PG_CIPHER_PASS, which/);
    expect(() =>
      assertRestoreAwareManifest(declared, engine, ['FLUI_PG_RESTORE']),
    ).not.toThrow();
  });
});
