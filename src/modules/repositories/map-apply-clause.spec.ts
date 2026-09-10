import { mapApplyClause } from './map-apply-clause';

/**
 * The sentence a person reads before conceding an apply. The route parameter
 * says which repository; this says what the request itself chose — and, just as
 * importantly, refuses to say anything the caller could have made up.
 */
describe('mapApplyClause', () => {
  it('says which branch is read and cut from', () => {
    expect(mapApplyClause({ branch: 'main' })).toBe('reading branch main');
  });

  it('says when only some units are being applied', () => {
    expect(mapApplyClause({ branch: 'main', unitIds: ['api', 'web'] })).toBe(
      'reading branch main, only api, web',
    );
  });

  it('counts the rest rather than growing without bound', () => {
    expect(mapApplyClause({ unitIds: ['a', 'b', 'c', 'd', 'e'] })).toBe(
      'only a, b, c and 2 more',
    );
  });

  it('adds nothing when the body decided nothing', () => {
    expect(mapApplyClause({})).toBeUndefined();
    expect(mapApplyClause({ unitIds: [] })).toBeUndefined();
    expect(mapApplyClause(undefined)).toBeUndefined();
    expect(mapApplyClause('not an object')).toBeUndefined();
  });

  /**
   * The body is unvalidated at the gate and whatever this returns is frozen
   * into the stored sentence, so it is flattened and cut rather than trusted.
   */
  it('flattens and truncates whatever it was handed', () => {
    const clause = mapApplyClause({ branch: 'feature/\n  long' });
    expect(clause).toBe('reading branch feature/ long');
    const long = mapApplyClause({ branch: 'x'.repeat(200) });
    expect(long!.length).toBeLessThan(120);
    expect(long).toContain('…');
  });

  it('ignores a branch that is not a string at all', () => {
    expect(mapApplyClause({ branch: 42, unitIds: ['api'] })).toBe('only api');
    expect(mapApplyClause({ unitIds: [7, false] })).toBeUndefined();
  });

  /**
   * The identity is NOT read from here on purpose: a repository name taken off
   * the body would be a sentence the caller writes — approve `acme/shop`, act
   * on something else. `{id}` comes from the path, which is the thing being
   * acted on.
   */
  it('never repeats an identity the body asserts', () => {
    const clause = mapApplyClause({
      branch: 'main',
      repoFullName: 'totally/different',
      repositoryId: 'someone-elses-uuid',
    });
    expect(clause).not.toContain('totally/different');
    expect(clause).not.toContain('someone-elses-uuid');
  });
});
