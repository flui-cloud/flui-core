import { judgeMissingConnection } from './repo-connection';

/**
 * The branch worth pinning is the one the old message could not tell apart: a
 * repository the credential cannot reach. Telling someone to run
 * `flui repo connect` there sends them to a command that fails for a reason
 * nobody has named yet.
 */
describe('a deploy naming a repository this installation does not hold', () => {
  const reachable = { available: ['dawit-io/flui.landing'], canAsk: true };

  it('offers to connect one the credential reaches', () => {
    expect(judgeMissingConnection('dawit-io/flui.landing', reachable)).toEqual({
      kind: 'offer',
      repo: 'dawit-io/flui.landing',
    });
  });

  it('matches the name however GitHub cased it', () => {
    expect(
      judgeMissingConnection('Dawit-IO/Flui.Landing', reachable).kind,
    ).toBe('offer');
  });

  it('says the credential cannot see it, rather than sending you to connect', () => {
    const verdict = judgeMissingConnection('someone-else/private', reachable);
    expect(verdict.kind).toBe('unreachable');
    expect(verdict).toHaveProperty(
      'message',
      expect.stringContaining('cannot see'),
    );
    expect(verdict).not.toHaveProperty(
      'message',
      expect.stringContaining('flui repo connect someone-else/private'),
    );
  });

  /** `--non-interactive` has nobody to ask, so it must still name the command. */
  it('falls back to the command when there is nobody to ask', () => {
    const verdict = judgeMissingConnection('dawit-io/flui.landing', {
      ...reachable,
      canAsk: false,
    });
    expect(verdict.kind).toBe('instruct');
    expect(verdict).toHaveProperty(
      'message',
      expect.stringContaining('flui repo connect dawit-io/flui.landing'),
    );
  });

  /**
   * A listing that failed proves nothing either way, so it must not be read as
   * "the token cannot see it" — that would accuse the credential of a fault
   * that belongs to the network.
   */
  it('claims nothing when GitHub could not be asked', () => {
    const verdict = judgeMissingConnection('dawit-io/flui.landing', {
      available: [],
      canAsk: true,
      listingError: 'HTTP 503',
    });
    expect(verdict.kind).toBe('instruct');
    expect(verdict).toHaveProperty(
      'message',
      expect.stringContaining('HTTP 503'),
    );
  });
});
