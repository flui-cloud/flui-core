import {
  AnswerContext,
  UNDER_ABSENT,
  UNDER_ABSENT_REASON,
  proposalBehind,
  underAbsentFor,
} from './agent-activity.answer';

const ctx = (over: Partial<AnswerContext> = {}): AnswerContext => ({
  allowed: true,
  outcome: null,
  operationId: 'op-1',
  operationVisible: true,
  grantId: null,
  ...over,
});

describe('why the register names no permission', () => {
  it('says nothing at all when it does name one', () => {
    expect(underAbsentFor(ctx({ grantId: 'c-1' }), 'concession')).toBeNull();
    expect(underAbsentFor(ctx({ grantId: 'p-1' }), 'approval')).toBeNull();
  });

  /**
   * The bucket that used to be most of the column. The route is not one the
   * cycle pauses, or the caller was not an agent — so there was no answer to
   * record, which is a fact about the call and not a gap in the register.
   */
  it('distinguishes "never paused" from every other emptiness', () => {
    expect(underAbsentFor(ctx(), null)).toBe(UNDER_ABSENT.NOT_PAUSED);
  });

  it('separates "started nothing" from "started something you cannot see"', () => {
    expect(underAbsentFor(ctx({ operationId: null }), null)).toBe(
      UNDER_ABSENT.NO_OPERATION,
    );
    expect(underAbsentFor(ctx({ operationVisible: false }), null)).toBe(
      UNDER_ABSENT.OPERATION_WITHHELD,
    );
  });

  it('reads a refusal as having no permission to name', () => {
    expect(underAbsentFor(ctx({ allowed: false }), null)).toBe(
      UNDER_ABSENT.REFUSED,
    );
  });

  /**
   * A waiting turn is `allowed: true, error: null` on this table, so the
   * `allowed` test alone would have called it "not paused" — the exact opposite
   * of what happened. It is checked first for that reason.
   *
   * And it is checked off **one** column. Both surfaces that stop to ask now
   * write the outcome, so a row naming a raised request without one would be a
   * writer that forgot; reading that request as a second "waiting" signal would
   * answer correctly and hide the writer — which is how the confusion this
   * whole set exists to end came back a second time.
   */
  it('reads a turn that stopped to ask as waiting, not as refused or unpaused', () => {
    expect(underAbsentFor(ctx({ outcome: 'input_required' }), null)).toBe(
      UNDER_ABSENT.WAITING,
    );
    expect(
      underAbsentFor(ctx({ outcome: 'input_required', allowed: false }), null),
    ).toBe(UNDER_ABSENT.WAITING);
    expect(underAbsentFor(ctx({ outcome: null }), null)).not.toBe(
      UNDER_ABSENT.WAITING,
    );
  });

  it('has words for every reason, so a screen never shows a bare code', () => {
    for (const reason of Object.values(UNDER_ABSENT)) {
      expect(UNDER_ABSENT_REASON[reason]).toBeTruthy();
    }
  });
});

describe('the request a call departed under', () => {
  /**
   * "Allow once" is spent on the proposal itself and the guard stamps that id,
   * so the row already named its request — the service was resolving the id to
   * the word "approval" and throwing the id away.
   */
  it('is the grant itself when a one-off was spent', () => {
    expect(proposalBehind('approval', 'p-1', null)).toBe('p-1');
  });

  it('is what the standing permission was born from', () => {
    expect(proposalBehind('concession', 'c-1', 'p-1')).toBe('p-1');
  });

  /**
   * A concession minted before `fromProposalId` existed, or by any path that
   * did not record it. The honest answer is "not known", never the concession's
   * own id dressed up as a proposal.
   */
  it('is absent rather than guessed when the concession does not say', () => {
    expect(proposalBehind('concession', 'c-1', null)).toBeNull();
    expect(proposalBehind('concession', 'c-1', undefined)).toBeNull();
  });

  it('is absent when nothing answered for this call', () => {
    expect(proposalBehind(null, null, 'p-1')).toBeNull();
    expect(proposalBehind(null, 'c-1', 'p-1')).toBeNull();
  });
});
