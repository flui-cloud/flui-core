import { ACTION_CYCLE_KEY } from '../action-cycle/action-cycle.decorator';
import { composeSentence } from '../action-cycle/action-cycle.core';
import { OperatingContextController } from './operating-context.controller';
import { reachClauseOf, reachOf } from './operating-context.reach';

/**
 * The line exists for one moment: somebody about to write the first global
 * practice on an installation. Rule 2 says it descends to every tenant and to
 * the guests of the demonstration, on purpose — and that is the fact people get
 * wrong in the surprising direction, so the sentence has to state it rather
 * than describe the level in the abstract.
 */
describe('the line that says who a note reaches', () => {
  it('tells a platform practice it goes all the way down', () => {
    const reach = reachOf({ scopeType: 'global' }, 'practice');
    expect(reach).toMatchObject({
      audience: 'installation',
      descends: true,
      reachesGuests: true,
    });
    expect(reach.sentence).toContain('every tenant');
    expect(reach.sentence).toContain('guests of the demonstration');
  });

  it('tells a platform reason it goes nowhere below the platform', () => {
    const reach = reachOf({ scopeType: 'global' }, 'rationale');
    expect(reach).toMatchObject({ descends: false, reachesGuests: false });
    expect(reach.sentence).toContain('covers the whole installation');
  });

  it('names the cluster a cluster note is about', () => {
    const reach = reachOf(
      { scopeType: 'cluster', scopeRef: 'prod-1' },
      'practice',
    );
    expect(reach).toMatchObject({ audience: 'cluster', scopeRef: 'prod-1' });
    expect(reach.sentence).toContain('cluster prod-1');
    expect(reach.sentence).toContain('a single application there');
  });

  it('says a cluster’s reasons stop at whoever covers the cluster', () => {
    const reach = reachOf(
      { scopeType: 'cluster', scopeRef: 'prod-1' },
      'rationale',
    );
    expect(reach.descends).toBe(false);
    expect(reach.sentence).toContain('with an application on it does not');
  });

  /**
   * A selection is not counted as reaching a guest: whether it picks one out
   * depends on the selector, and a line that guessed would be worse than one
   * that says less.
   */
  it('claims nothing about guests for a selection', () => {
    expect(reachOf({ scopeType: 'selector' }, 'practice')).toMatchObject({
      audience: 'selection',
      descends: true,
      reachesGuests: false,
    });
  });

  /** It spells out no selector: the delivery withholds one, and so does this. */
  it('describes a selection without repeating what it selects', () => {
    const reach = reachOf(
      { scopeType: 'selector', selector: { owner: 'user-a' } },
      'practice',
    );
    expect(reach.sentence).not.toContain('user-a');
  });

  it('says something rather than nothing for a cluster note with no cluster', () => {
    expect(reachOf({ scopeType: 'cluster' }, 'practice').sentence).toContain(
      'this cluster',
    );
  });

  it('answers the same way for every level and nature', () => {
    for (const scopeType of ['global', 'cluster', 'selector'] as const) {
      for (const nature of ['practice', 'rationale'] as const) {
        const reach = reachOf({ scopeType, scopeRef: 'c1' }, nature);
        expect(reach.sentence.length).toBeGreaterThan(20);
        expect(reach.nature).toBe(nature);
      }
    }
  });
});

/**
 * The same line, said at the moment it actually changes somebody's answer: an
 * agent proposes a note, and a person is asked to allow it. Until now that
 * person read *write a new operating-context note* — the verb, and nothing
 * about who would end up reading it.
 */
describe('the line inside the sentence a person approves', () => {
  it('says who will read the note the body describes', () => {
    expect(
      reachClauseOf({ scopeType: 'global', nature: 'practice' }),
    ).toContain('guests of the demonstration');
    expect(
      reachClauseOf({
        scopeType: 'cluster',
        scopeRef: 'c1',
        nature: 'practice',
      }),
    ).toContain('cluster c1');
    expect(
      reachClauseOf({ scopeType: 'global', nature: 'rationale' }),
    ).toContain('covers the whole installation');
  });

  /**
   * Guards run before the validation pipe, so this is handed whatever was
   * posted. Anything it cannot recognise is a request the pipe refuses a moment
   * later; a clause that guessed would put a wrong sentence in front of a
   * person, and one that threw would turn a 400 into a 500.
   */
  it('says nothing about a body it cannot read', () => {
    expect(reachClauseOf(undefined)).toBeUndefined();
    expect(reachClauseOf('global')).toBeUndefined();
    expect(reachClauseOf({ nature: 'practice' })).toBeUndefined();
    expect(
      reachClauseOf({ scopeType: 'project', nature: 'practice' }),
    ).toBeUndefined();
    expect(
      reachClauseOf({ scopeType: 'global', nature: 'gossip' }),
    ).toBeUndefined();
    expect(
      reachClauseOf({ scopeType: 'global', nature: ['practice'] }),
    ).toBeUndefined();
  });

  /**
   * The half that makes it a product rather than a function: the route has to
   * declare it. A clause nobody attaches is prose nobody reads.
   */
  it('is what the write route actually declares', () => {
    const decl = Reflect.getMetadata(
      ACTION_CYCLE_KEY,
      OperatingContextController.prototype.create,
    );

    expect(decl.action).toBe('POST /operating-context');
    expect(
      composeSentence(decl.sentence, undefined, decl.clause, {
        scopeType: 'global',
        nature: 'practice',
      }),
    ).toBe(
      'write a new operating-context note — ' +
        reachOf({ scopeType: 'global' }, 'practice').sentence,
    );
  });
});
