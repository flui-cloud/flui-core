import { applicationPath, pendingOf } from './app-pending.rules';

const AT = '2026-09-30T10:00:00.000Z';

describe('pendingOf', () => {
  it('explains a database that is not running and says a policy would not help', () => {
    expect(
      pendingOf(
        {
          outcome: 'waiting',
          reason: 'the database is not running yet',
          at: AT,
        },
        false,
      ),
    ).toEqual({
      outcome: 'waiting',
      reason: 'the database is not running yet',
      at: AT,
      protectHelps: false,
    });
  });

  it('forgets the wait once the database runs', () => {
    expect(pendingOf({ outcome: 'waiting', at: AT }, true)).toBeNull();
  });

  it('keeps a failure, which a policy made by hand may get past', () => {
    expect(
      pendingOf({ outcome: 'failed', reason: 'quota', at: AT }, true),
    ).toMatchObject({ outcome: 'failed', reason: 'quota', protectHelps: true });
  });

  it('waits for the decision rather than offering a policy', () => {
    expect(
      pendingOf(
        { outcome: 'needs_decision', reason: 'live data', at: AT },
        true,
      ),
    ).toMatchObject({ protectHelps: false });
  });

  it('says nothing about an application already protected', () => {
    expect(pendingOf({ outcome: 'protected', at: AT }, true)).toBeNull();
    expect(pendingOf(undefined, false)).toBeNull();
  });
});

describe('applicationPath', () => {
  it('is the application page', () => {
    expect(applicationPath('abc')).toBe('/apps/applications/abc');
  });
});
