import { selectorForAgent } from './delivered-selector';

describe('what a note is written on, as an agent may be told it', () => {
  it('hands over the axes that describe resources, unchanged', () => {
    const seen = selectorForAgent({
      clusterId: 'c1',
      kind: 'postgres',
      slugs: ['api', 'worker'],
      tags: ['prod'],
      project: 'acme',
      provider: 'hetzner',
      clusterName: 'prod',
      type: 'user',
    });

    expect(seen.selector).toEqual({
      clusterId: 'c1',
      kind: 'postgres',
      slugs: ['api', 'worker'],
      tags: ['prod'],
      project: 'acme',
      provider: 'hetzner',
      clusterName: 'prod',
      type: 'user',
    });
    expect(seen.pinnedToAnOwner).toBe(false);
  });

  /**
   * The one axis of a selector that names a person rather than a resource, and
   * the one the *permissive* reach lets through to a reader the restrictive
   * half would have refused: a grant following `{kind: 'postgres'}` meets a
   * note written on `{owner: <somebody else>}`, because `intersects` discards
   * an axis only when both sides declare it.
   */
  it('withholds the principal a note follows', () => {
    const seen = selectorForAgent({ owner: 'u1', kind: 'postgres' });

    expect(seen.selector).toEqual({ kind: 'postgres' });
    expect(JSON.stringify(seen)).not.toContain('u1');
  });

  /**
   * Dropping the axis silently would say something wider than the note does:
   * an empty selector reads as "this applies to everything".
   */
  it('says the note is pinned to somebody rather than pretending it is not', () => {
    const seen = selectorForAgent({ owner: 'u1' });

    expect(seen.selector).toBeNull();
    expect(seen.pinnedToAnOwner).toBe(true);
  });

  it('has nothing to say about a note that carries no selector', () => {
    expect(selectorForAgent(null)).toEqual({
      selector: null,
      pinnedToAnOwner: false,
    });
    expect(selectorForAgent(undefined).selector).toBeNull();
  });

  /**
   * An allow-list, not a subtraction: an axis added to `IamSelector` later stays
   * out of a model's context until somebody puts it in the list on purpose.
   */
  it('does not pass an axis nobody named', () => {
    const seen = selectorForAgent({
      kind: 'postgres',
      secretHandle: 'sh-1',
    } as never);

    expect(seen.selector).toEqual({ kind: 'postgres' });
  });
});
