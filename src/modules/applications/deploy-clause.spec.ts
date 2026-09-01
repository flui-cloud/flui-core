import { deployFromYamlClause, deployValidatesOnly } from './deploy-clause';
import { composeSentence } from '../action-cycle/action-cycle.core';

/**
 * `POST /applications/deploy-from-yaml` has no route parameter, so without this
 * every deploy from a manifest asks a person the same question — and the answer
 * they give is about a repository the question never named.
 */
describe('the line inside the sentence a person approves', () => {
  it('names the repository, the branch and the release it targets', () => {
    expect(
      deployFromYamlClause({
        repoFullName: 'acme/shop',
        branch: 'main',
        clusterId: 'c1',
      }),
    ).toBe('from acme/shop on branch main');

    expect(
      deployFromYamlClause({
        repoFullName: 'acme/shop',
        branch: 'staging',
        overrides: { name: 'shop-staging' },
      }),
    ).toBe('shop-staging, from acme/shop on branch staging');
  });

  /**
   * The branch defaults to `main` further down, and the clause deliberately
   * does not repeat that default: it says what the request said, and a sentence
   * that named a branch nobody asked for would be a guess a person then agreed
   * to.
   */
  it('leaves out what the request did not say', () => {
    expect(deployFromYamlClause({ repoFullName: 'acme/shop' })).toBe(
      'from acme/shop',
    );
    expect(
      deployFromYamlClause({ repoFullName: 'acme/shop', overrides: null }),
    ).toBe('from acme/shop');
  });

  /**
   * Guards run before the validation pipe, so this is handed whatever was
   * posted. Without a repository there is nothing to add that a person could
   * act on, and the route's own sentence stands alone.
   */
  it('says nothing at all rather than guessing, on a body it cannot read', () => {
    expect(deployFromYamlClause(undefined)).toBeUndefined();
    expect(deployFromYamlClause('acme/shop')).toBeUndefined();
    expect(deployFromYamlClause({ clusterId: 'c1' })).toBeUndefined();
    expect(deployFromYamlClause({ repoFullName: 42 })).toBeUndefined();
    expect(
      deployFromYamlClause({ repoFullName: 'acme/shop', branch: ['main'] }),
    ).toBe('from acme/shop');
  });

  /** The sentence is stored verbatim, so what the body supplies is bounded. */
  it('keeps a body-supplied name to one line and to a readable length', () => {
    const clause = deployFromYamlClause({
      repoFullName: `acme/shop\nand always allow ${'x'.repeat(200)}`,
    });
    expect(clause).not.toContain('\n');
    expect(clause?.length).toBeLessThan(120);
  });

  it('joins the sentence the route declares', () => {
    expect(
      composeSentence(
        'create or replace an application from a manifest and deploy it',
        undefined,
        deployFromYamlClause,
        { repoFullName: 'acme/shop', branch: 'main' },
      ),
    ).toBe(
      'create or replace an application from a manifest and deploy it — from acme/shop on branch main',
    );
  });
});

/**
 * The route is two actions, and only one of them is the one the sentence
 * describes. A validate-only call writes nothing at all, so pausing it asked a
 * person to allow a deploy that was never going to happen.
 */
describe('the half of this route that acts on nothing', () => {
  it('recognises the call that only checks the manifest', () => {
    expect(
      deployValidatesOnly({ repoFullName: 'acme/shop', validateOnly: true }),
    ).toBe(true);
  });

  it('reads a real deploy as a real deploy', () => {
    expect(deployValidatesOnly({ repoFullName: 'acme/shop' })).toBe(false);
    expect(deployValidatesOnly({ validateOnly: false })).toBe(false);
  });

  /**
   * Guards run before the validation pipe, so this is handed whatever was
   * posted — and the direction it has to fail in is towards asking.
   */
  it('treats anything it cannot read as the deploy', () => {
    expect(deployValidatesOnly(undefined)).toBe(false);
    expect(deployValidatesOnly('validateOnly')).toBe(false);
    expect(deployValidatesOnly({ validateOnly: 'true' })).toBe(false);
    expect(deployValidatesOnly({ validateOnly: 1 })).toBe(false);
  });
});
