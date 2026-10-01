import {
  NOTE_MAX,
  backupDecisionClause,
  backupDecisionFrom,
  notBackedUpByChoice,
} from './app-backup-decision.rules';

const NOW = new Date('2026-10-01T09:00:00Z');
const user = { userId: 'u1', displayName: 'Dawit', email: 'd@example.com' };

describe('backupDecisionFrom', () => {
  it('records who decided, when, and the note, trimmed', () => {
    expect(
      backupDecisionFrom(
        { notBackedUp: true, note: '  scratch copy  ' },
        user,
        NOW,
      ),
    ).toEqual({
      notBackedUp: true,
      note: 'scratch copy',
      decidedBy: 'u1',
      decidedByName: 'Dawit',
      decidedAt: '2026-10-01T09:00:00.000Z',
    });
  });

  it('keeps no empty note and names the person by email when that is all there is', () => {
    const d = backupDecisionFrom(
      { notBackedUp: true, note: '   ' },
      { userId: 'u2', email: 'ops@example.com' },
      NOW,
    );
    expect(d).not.toHaveProperty('note');
    expect(d?.decidedByName).toBe('ops@example.com');
  });

  it('cuts a long note to the limit', () => {
    const d = backupDecisionFrom(
      { notBackedUp: true, note: 'x'.repeat(NOTE_MAX + 50) },
      user,
      NOW,
    );
    expect(d?.note).toHaveLength(NOTE_MAX);
  });

  it('stores nothing when the application is to be backed up again', () => {
    expect(
      backupDecisionFrom({ notBackedUp: false, note: 'ignored' }, user, NOW),
    ).toBeNull();
  });
});

describe('notBackedUpByChoice', () => {
  it('is true only for a stored decision', () => {
    expect(notBackedUpByChoice(null)).toBe(false);
    expect(notBackedUpByChoice(undefined)).toBe(false);
    expect(
      notBackedUpByChoice({
        notBackedUp: true,
        decidedBy: 'u1',
        decidedAt: NOW.toISOString(),
      }),
    ).toBe(true);
  });
});

describe('backupDecisionClause', () => {
  it('tells the person approving which way the request goes', () => {
    expect(backupDecisionClause({ notBackedUp: false })).toBe(
      'back it up again',
    );
    expect(backupDecisionClause({ notBackedUp: true, note: 'scratch' })).toBe(
      'note: scratch',
    );
    expect(backupDecisionClause({ notBackedUp: true })).toBeUndefined();
    expect(backupDecisionClause(null)).toBeUndefined();
  });
});
