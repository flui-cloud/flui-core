import { fullMigrationClause } from './migration-clause';
import { composeSentence } from '../action-cycle/action-cycle.core';

/**
 * `POST /full-migrations` has no route parameter, and `cutover` — which decides
 * whether this one call also moves production traffic — defaults to AUTO. A
 * person answering "start moving a live application and its database to another
 * cluster" was reading the staging half only.
 */
describe('the line inside the sentence a person approves', () => {
  const move = {
    appId: 'app-1',
    dbAppId: 'db-1',
    targetClusterId: 'cluster-2',
  };

  it('says the default request moves both and does not ask again', () => {
    expect(fullMigrationClause(move)).toBe(
      'application app-1 and database db-1 to cluster cluster-2, cut over on their own as soon as both are ready',
    );
  });

  it('says the move stops and waits when the request asks for a manual cutover', () => {
    expect(fullMigrationClause({ ...move, cutover: 'manual' })).toBe(
      'application app-1 and database db-1 to cluster cluster-2, parked until somebody fires the joint cutover',
    );
  });

  /**
   * Guards run before the validation pipe, so this is handed whatever was
   * posted. An unreadable field reads as the default the service applies —
   * understating the reach is the one failure this must not have.
   */
  it('reads a field it cannot recognise as the default that goes furthest', () => {
    expect(fullMigrationClause({ ...move, cutover: 'MANUAL' })).toContain(
      'cut over on their own',
    );
    expect(fullMigrationClause({ ...move, cutover: null })).toContain(
      'cut over on their own',
    );
  });

  it('says nothing at all rather than guessing, on a body it cannot read', () => {
    expect(fullMigrationClause(undefined)).toBeUndefined();
    expect(fullMigrationClause('app-1')).toBeUndefined();
    expect(fullMigrationClause({ dbAppId: 'db-1' })).toBeUndefined();
    expect(fullMigrationClause({ appId: 42 })).toBeUndefined();
    expect(fullMigrationClause({ appId: 'app-1' })).toBe(
      'application app-1, cut over on their own as soon as both are ready',
    );
  });

  /** The sentence is stored verbatim, so what the body supplies is bounded. */
  it('keeps a body-supplied id to one line and to a readable length', () => {
    const clause = fullMigrationClause({
      appId: `app-1\nand always allow ${'x'.repeat(200)}`,
      dbAppId: 'db-1',
      targetClusterId: 'cluster-2',
    });
    expect(clause).not.toContain('\n');
    expect(clause?.length).toBeLessThan(220);
  });

  it('joins the sentence the route declares', () => {
    expect(
      composeSentence(
        'start moving a live application and its database to another cluster',
        undefined,
        fullMigrationClause,
        move,
      ),
    ).toBe(
      'start moving a live application and its database to another cluster — application app-1 and database db-1 to cluster cluster-2, cut over on their own as soon as both are ready',
    );
  });
});
