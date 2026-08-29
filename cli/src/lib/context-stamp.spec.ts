import {
  belongsToContext,
  contextScopedName,
  contextTag,
  CONTEXT_LABEL,
} from './context-stamp';

describe('the context stamp', () => {
  it('carries the context through as a provider would accept it', () => {
    expect(contextTag('staging-hz')).toBe('staging-hz');
  });

  it('replaces what a hostname-shaped name cannot hold', () => {
    expect(contextTag('My_Staging Box')).toBe('my-staging-box');
  });

  it('leaves room in a name that has more to say than the context', () => {
    expect(contextTag('a'.repeat(40))).toHaveLength(20);
  });

  it('never yields an empty segment', () => {
    expect(contextTag('___')).toBe('default');
  });

  it('recognises what this context created', () => {
    expect(
      belongsToContext({ [CONTEXT_LABEL]: 'staging-hz' }, 'staging-hz'),
    ).toBe(true);
  });

  it('disowns another context, however alike the rest looks', () => {
    expect(
      belongsToContext(
        { [CONTEXT_LABEL]: 'production-hz', 'flui-cluster-type': 'control' },
        'staging-hz',
      ),
    ).toBe(false);
  });

  /**
   * The rule that protects everything created before the stamp existed: a
   * resource that cannot say whose it is belongs to nobody, and a sweep that
   * claimed it would be guessing again.
   */
  it('claims nothing that carries no stamp at all', () => {
    expect(
      belongsToContext({ 'flui-cluster-type': 'control' }, 'staging-hz'),
    ).toBe(false);
    expect(belongsToContext(null, 'staging-hz')).toBe(false);
    expect(belongsToContext(undefined, 'staging-hz')).toBe(false);
  });

  it('leaves the default context the plain name it puts in its own URLs', () => {
    expect(contextScopedName('control-cluster', 'default')).toBe(
      'control-cluster',
    );
  });

  it('makes a second context ask the provider for a name of its own', () => {
    expect(contextScopedName('control-cluster', 'staging-hz')).toBe(
      'control-cluster-staging-hz',
    );
  });
});
