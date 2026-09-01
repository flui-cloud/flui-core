import { dbMigrationClause } from './migration-clause';
import { composeSentence } from '../action-cycle/action-cycle.core';

/**
 * `POST /db-migrations` has no route parameter, and the field that decides how
 * far the call goes — `cutover`, which defaults to AUTO — is in the body. A
 * person answering "start moving a database to another cluster" was reading the
 * staging half of an action that, by default, also repoints the application and
 * stops the source taking writes.
 */
describe('the line inside the sentence a person approves', () => {
  const to = { srcAppId: 'app-1', targetClusterId: 'cluster-2' };

  it('says the default request finishes the move on its own', () => {
    expect(dbMigrationClause(to)).toBe(
      'database app-1 to cluster cluster-2, replicated live and cut over on its own as soon as it is in sync',
    );
  });

  it('says so too when the request spells the default out', () => {
    expect(dbMigrationClause({ ...to, mode: 'live', cutover: 'auto' })).toBe(
      'database app-1 to cluster cluster-2, replicated live and cut over on its own as soon as it is in sync',
    );
  });

  it('says the move stops and waits when the request asks for a manual cutover', () => {
    expect(dbMigrationClause({ ...to, cutover: 'manual' })).toBe(
      'database app-1 to cluster cluster-2, replicated live and parked until somebody fires the cutover',
    );
  });

  /**
   * Restore mode has no replication link and never reaches a cutover: it
   * rebuilds the database from the backup repository and completes. Saying it
   * is "kept in step with the live one" was false for half the modes this route
   * advertises.
   */
  it('does not claim a restore is kept in step with anything', () => {
    const clause = dbMigrationClause({ ...to, mode: 'restore' });
    expect(clause).toContain('restored from the backup repository');
    expect(clause).not.toContain('replicated');
    expect(clause).not.toContain('cut over');
  });

  /**
   * Guards run before the validation pipe, so this is handed whatever was
   * posted. An unreadable field reads as the default the service applies —
   * understating the reach is the one failure this must not have.
   */
  it('reads a field it cannot recognise as the default that goes furthest', () => {
    expect(dbMigrationClause({ ...to, cutover: 'MANUAL' })).toContain(
      'cut over on its own',
    );
    expect(dbMigrationClause({ ...to, mode: ['restore'] })).toContain(
      'replicated live',
    );
  });

  it('says nothing at all rather than guessing, on a body it cannot read', () => {
    expect(dbMigrationClause(undefined)).toBeUndefined();
    expect(dbMigrationClause('app-1')).toBeUndefined();
    expect(dbMigrationClause({ targetClusterId: 'cluster-2' })).toBeUndefined();
    expect(dbMigrationClause({ srcAppId: 42 })).toBeUndefined();
    expect(dbMigrationClause({ srcAppId: 'app-1' })).toContain(
      'database app-1,',
    );
  });

  /** The sentence is stored verbatim, so what the body supplies is bounded. */
  it('keeps a body-supplied id to one line and to a readable length', () => {
    const clause = dbMigrationClause({
      srcAppId: `app-1\nand always allow ${'x'.repeat(200)}`,
      targetClusterId: 'cluster-2',
    });
    expect(clause).not.toContain('\n');
    expect(clause?.length).toBeLessThan(200);
  });

  it('joins the sentence the route declares', () => {
    expect(
      composeSentence(
        'start moving a database to another cluster',
        undefined,
        dbMigrationClause,
        { ...to, cutover: 'manual' },
      ),
    ).toBe(
      'start moving a database to another cluster — database app-1 to cluster cluster-2, replicated live and parked until somebody fires the cutover',
    );
  });
});
