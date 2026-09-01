import {
  SYSTEM_DB_TARGETS,
  SYSTEM_DB_TARGET_NAMES,
  systemDbTarget,
} from './system-db-target';
import { FOUNDATION_REACH } from 'src/modules/database-console/constants/platform-foundations';

/**
 * The reserved names decide whether `flui db tunnel <name>` opens an
 * application's database or the product's own. Getting that wrong is not a
 * cosmetic bug — it silently sends somebody to a different database than the
 * one they named — so what is pinned here is the boundary, not the table.
 */
describe('the names the tunnel answers to itself', () => {
  it('recognises the two foundations by their own keys', () => {
    expect(systemDbTarget('platform-postgres')?.key).toBe('platform-postgres');
    expect(systemDbTarget('identity-provider')?.key).toBe('identity-provider');
  });

  /**
   * A tenant may legitimately name or slug an application `postgres`, and
   * `getAppByName` matches case-insensitively on either. An alias here would
   * quietly change which database an existing command opens.
   */
  it('claims none of the names a tenant application could hold', () => {
    for (const name of [
      'postgres',
      'postgresql',
      'zitadel',
      'db',
      'postgres-815796',
    ]) {
      expect(systemDbTarget(name)).toBeNull();
    }
  });

  it('leaves an ordinary application name to the application lookup', () => {
    expect(systemDbTarget('postgresql-051f58')).toBeNull();
    expect(systemDbTarget('')).toBeNull();
    expect(systemDbTarget(undefined)).toBeNull();
  });

  it('is not case- or whitespace-sensitive about a name it does claim', () => {
    expect(systemDbTarget('  Platform-Postgres ')?.key).toBe(
      'platform-postgres',
    );
  });

  /**
   * The Secret's address lives here and not on the wire, which is the reason
   * the API can name the database and the role without naming where the
   * password is. The cost of that is this table, so it has to be complete.
   */
  it('carries a Secret and at least one key for every target', () => {
    for (const target of SYSTEM_DB_TARGETS) {
      expect(target.secretName).toMatch(/-secrets$/);
      expect(target.secretKeys.length).toBeGreaterThan(0);
      expect(target.label.length).toBeGreaterThan(0);
    }
  });

  it('reads the identity provider password of the user role, not the owner of the schema', () => {
    expect(systemDbTarget('identity-provider')?.secretKeys).toEqual([
      'db-user-password',
    ]);
  });

  /**
   * Two tables in two packages, and the one failure they can have together is
   * silent: a key the CLI asks for that the API does not declare answers the
   * same absence as a key nobody may reach, so the feature simply stops working
   * with no way to tell why from the outside.
   */
  it('asks for exactly the foundations the API declares a road to', () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...SYSTEM_DB_TARGET_NAMES].sort(byName)).toEqual(
      FOUNDATION_REACH.map((r) => r.key).sort(byName),
    );
  });

  it('offers every declared target in the help text', () => {
    expect(SYSTEM_DB_TARGET_NAMES).toEqual(SYSTEM_DB_TARGETS.map((t) => t.key));
  });
});
