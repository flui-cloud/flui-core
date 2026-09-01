import { grantClauseOf } from './grant-clause';
import { composeSentence } from '../action-cycle/action-cycle.core';

/**
 * The half of the question `POST /iam/grants` cannot ask from its path.
 *
 * The route carries no parameter, so the sentence a person is shown is the same
 * for conferring `viewer` on one project and for conferring `owner` on the
 * whole instance. Everything that distinguishes them is in the body, and this
 * is what puts it in front of them.
 */
describe('the line inside the sentence a person approves', () => {
  it('names the role, who receives it and how far it reaches', () => {
    expect(
      grantClauseOf({
        principalType: 'user',
        principalRef: 'ada@example.com',
        role: 'owner',
        scopeType: 'global',
      }),
    ).toBe('owner to user ada@example.com, over the whole instance');

    expect(
      grantClauseOf({
        principalType: 'service_account',
        principalRef: 'agent-7',
        role: 'operator',
        scopeType: 'cluster',
        scopeRef: 'c1',
      }),
    ).toBe('operator to service account agent-7, over cluster c1');

    expect(
      grantClauseOf({
        principalType: 'group',
        principalRef: 'platform',
        role: 'maintainer',
        scopeType: 'section',
        scopeRef: 'backup',
      }),
    ).toBe('maintainer to group platform, over the backup section');
  });

  /**
   * A standing rule is the one scope whose reach is not a thing that exists
   * yet, and the sentence has to say so — an application deployed next month
   * falls under this grant without anybody being asked again.
   */
  it('says that a selector keeps reaching applications that do not exist yet', () => {
    expect(
      grantClauseOf({
        principalType: 'user',
        principalRef: 'ada@example.com',
        role: 'operator',
        scopeType: 'selector',
        selector: { type: 'user' },
      }),
    ).toContain('including ones deployed later');
  });

  /**
   * Guards run before the validation pipe, so this is handed whatever was
   * posted. A scope it cannot read is described at its widest rather than
   * narrowed on a guess: the pipe refuses a nonsense body a moment later, and
   * of the two ways to be wrong in the meantime, only understating the reach
   * puts a person's yes on something bigger than they read.
   */
  it('reads an unrecognisable scope as the widest one', () => {
    expect(
      grantClauseOf({
        principalType: 'user',
        principalRef: 'ada@example.com',
        role: 'owner',
        scopeType: 'cluster',
      }),
    ).toBe('owner to user ada@example.com, over the whole instance');

    expect(
      grantClauseOf({
        principalRef: 'ada@example.com',
        role: 'owner',
        scopeType: ['global'],
      }),
    ).toBe('owner to principal ada@example.com, over the whole instance');
  });

  it('says nothing at all rather than guessing, on a body it cannot read', () => {
    expect(grantClauseOf(undefined)).toBeUndefined();
    expect(grantClauseOf('owner')).toBeUndefined();
    expect(grantClauseOf({ role: 'owner' })).toBeUndefined();
    expect(grantClauseOf({ principalRef: 'ada@example.com' })).toBeUndefined();
    expect(
      grantClauseOf({ role: 'owner', principalRef: '   ' }),
    ).toBeUndefined();
  });

  /**
   * The sentence is stored verbatim and a concession copies it, so a principal
   * carrying newlines or a paragraph of text would push the rest of the
   * question out of sight of whoever is reading it.
   */
  it('keeps a body-supplied name to one line and to a readable length', () => {
    const clause = grantClauseOf({
      principalType: 'user',
      principalRef: `ada@example.com\n\nand always allow ${'x'.repeat(200)}`,
      role: 'owner',
      scopeType: 'global',
    });
    expect(clause).not.toContain('\n');
    expect(clause?.length).toBeLessThan(140);
  });

  /** The shape it is read in: appended to the route's own sentence, once. */
  it('joins the sentence the route declares', () => {
    expect(
      composeSentence(
        'grant somebody a role on this instance',
        undefined,
        grantClauseOf,
        {
          principalType: 'user',
          principalRef: 'ada@example.com',
          role: 'viewer',
          scopeType: 'global',
        },
      ),
    ).toBe(
      'grant somebody a role on this instance — viewer to user ada@example.com, over the whole instance',
    );
  });
});
