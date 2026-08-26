import {
  ProbeExpectationProblem,
  interpretExpected,
} from './probe-expectation';

/**
 * Decision 166, at the only place it can be fixed once.
 *
 * The comparison downstream is a strict `===` and it stays that way: the bug
 * was never the strictness, it was that a form posts strings and nothing turned
 * `"3"` into `3` before it was stored next to a `nodeCount` of `3`. A note that
 * declares itself broken for a reason that was never true teaches its readers
 * that the flag means nothing, which is worse than not having the flag.
 */
describe('a premise read in the type its probe answers', () => {
  it('reads the string a form posted as the number the probe answers', () => {
    expect(interpretExpected('number', 'equals', '3')).toBe(3);
    expect(interpretExpected('number', 'atLeast', ' 3 ')).toBe(3);
  });

  it('reads a checkbox as the boolean the probe answers', () => {
    expect(interpretExpected('boolean', 'equals', 'true')).toBe(true);
    expect(interpretExpected('boolean', 'equals', 'FALSE')).toBe(false);
    expect(interpretExpected('boolean', 'notEquals', true)).toBe(true);
  });

  it('reads a number typed against a string field as that string', () => {
    expect(interpretExpected('string', 'equals', 3)).toBe('3');
  });

  it('leaves a premise exactly as written when the probe never said', () => {
    expect(interpretExpected(undefined, 'equals', '3')).toBe('3');
  });

  /**
   * The refusals. Every one of them describes a note that would have been saved
   * happily and then been permanently wrong about itself — which is the failure
   * this whole mechanism exists to make impossible.
   */
  it('refuses prose where the probe answers a number', () => {
    expect(() => interpretExpected('number', 'equals', 'about three')).toThrow(
      ProbeExpectationProblem,
    );
  });

  it('refuses a word where the probe answers a boolean', () => {
    expect(() => interpretExpected('boolean', 'equals', 'yes')).toThrow(
      ProbeExpectationProblem,
    );
  });

  it('refuses an object where a value was needed', () => {
    expect(() => interpretExpected('string', 'equals', { a: 1 })).toThrow(
      ProbeExpectationProblem,
    );
  });

  it('refuses ordering a field the probe does not answer as a number', () => {
    expect(() => interpretExpected('string', 'atLeast', 'running')).toThrow(
      /only compares numbers/,
    );
  });

  it('refuses ordering against something that is not a number, type or no type', () => {
    expect(() => interpretExpected(undefined, 'atMost', 'lots')).toThrow(
      ProbeExpectationProblem,
    );
  });

  /** `exists` is the op for "there is one"; equality against nothing is a mistake. */
  it('sends a premise compared with nothing to the op that means it', () => {
    expect(() => interpretExpected('string', 'equals', null)).toThrow(/exists/);
    expect(() => interpretExpected(undefined, 'equals', undefined)).toThrow(
      /exists/,
    );
  });

  it('stores nothing next to an existence check', () => {
    expect(
      interpretExpected('number', 'exists', 'whatever was posted'),
    ).toBeNull();
  });

  /** The message is what the author reads while the form is still open. */
  it('says what the probe answers and what was written', () => {
    expect(() => interpretExpected('number', 'equals', 'three')).toThrow(
      /answers a number.*three/,
    );
  });
});
