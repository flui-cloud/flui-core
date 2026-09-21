import {
  UNDECLARED_ENVIRONMENT_LABEL,
  environmentBadge,
  readEnvironment,
} from './environment';

/**
 * The rule that matters is the one for an installation nobody configured: it is
 * marked, not trusted. A boolean would have defaulted the other way, and a stage
 * that forgot to say so would have been indistinguishable from the real thing.
 */
describe('telling a person which Flui they are looking at', () => {
  it('marks nothing only when production is declared', () => {
    expect(environmentBadge('production')).toEqual({ show: false, label: '' });
  });

  it('marks an installation that declared nothing', () => {
    for (const nothing of [undefined, null, '', '   ']) {
      expect(environmentBadge(nothing)).toEqual({
        show: true,
        label: UNDECLARED_ENVIRONMENT_LABEL,
      });
    }
  });

  /**
   * `envsubst` blanks a variable nobody exported, so an unset value arrives as
   * an empty string rather than as absent. Both have to land on the mark.
   */
  it('marks a value the installer blanked', () => {
    expect(environmentBadge('').show).toBe(true);
  });

  it('marks a name it does not recognise rather than passing it through', () => {
    const badge = environmentBadge('prod');
    expect(badge.show).toBe(true);
    expect(badge.label).toBe(UNDECLARED_ENVIRONMENT_LABEL);
  });

  it('names the environments it knows', () => {
    expect(environmentBadge('staging').label).toBe('Staging');
    expect(environmentBadge('preview').label).toBe('Preview');
    expect(environmentBadge('development').label).toBe('Development');
  });

  it('reads a name however it was cased or padded', () => {
    expect(readEnvironment(' Staging ')).toBe('staging');
    expect(readEnvironment('PRODUCTION')).toBe('production');
  });

  it('refuses to read a name it does not know', () => {
    expect(readEnvironment('prod')).toBeNull();
    expect(readEnvironment('stage')).toBeNull();
  });
});
