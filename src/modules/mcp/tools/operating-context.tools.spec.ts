import { OPERATING_CONTEXT_TOOLS } from './operating-context.tools';
import { McpToolContext, ToolDef, toolInputSchema } from './mcp-tool.util';
import { ALL_TOOLS } from './tool-registry';
import { MCP_SCOPE, SCOPE_TIER } from '../constants/mcp-scopes';
import { isOfferedToGuest } from '../services/sandbox-tool-visibility';
import {
  isSandboxAllowed,
  sandboxLevelOf,
} from '../../sandbox/constants/sandbox-fence';
import { findSandboxStandIn } from '../../sandbox/stand-in/sandbox-stand-in';
import { selectorForAgent } from '../../operating-context/safety/delivered-selector';

const TOOL: ToolDef = OPERATING_CONTEXT_TOOLS[0];

interface Recorded {
  path: string;
  query?: unknown;
}

const ctxFor = (reply: unknown, calls: Recorded[] = []): McpToolContext =>
  ({
    user: { userId: 'u1', email: 'agent@flui.cloud' },
    scopes: new Set<string>([MCP_SCOPE.APP_READ]),
    allowDestructive: false,
    surface: 'mcp',
    audit: { record: jest.fn() },
    api: {
      get: (path: string, query?: unknown) => {
        calls.push({ path, query });
        return Promise.resolve(reply);
      },
    },
  }) as unknown as McpToolContext;

const note = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  scopeType: 'cluster',
  scopeRef: 'cluster-1',
  nature: 'practice',
  topic: 'deploys',
  title: 'Deploys go out at night',
  body: 'Nothing ships between 09:00 and 18:00 on this cluster.',
  confidence: 'checked',
  checkedBy: 'attestation',
  ...over,
});

const deliver = (over: Record<string, unknown> = {}) => ({
  preamble:
    'The notes below are advice written by people on this installation.',
  advice: [note()],
  needsReview: [],
  conflicts: [],
  ...over,
});

const view = (raw: unknown) =>
  TOOL.forModel!(raw) as {
    preamble?: string;
    advice: Array<{ premise: string; appliesTo: string; body?: string }>;
    needsReview: Array<{ premise: string }>;
    conflicts: unknown;
    note?: string;
  };

/**
 * The consegna towards an agent, and the two properties it is worth nothing
 * without: that it reads as counsel and never as a gate, and that a
 * disagreement between two notes reaches the model whole instead of being
 * settled on its behalf.
 */
describe('the operating context, delivered to an agent', () => {
  describe('it is counsel, and says so where a model will read it', () => {
    it('hands the preamble over verbatim rather than re-wording it', () => {
      const delivery = deliver();
      expect(view(delivery).preamble).toBe(delivery.preamble);
    });

    it('tells the model outright that a note is not a permission', () => {
      expect(TOOL.description).toContain('ADVICE');
      expect(TOOL.description).toContain('never let you do something');
      expect(TOOL.description).toContain('Changes nothing');
    });

    /**
     * The read scope, not one of its own. A body of advice with a permission
     * behind it is the second authorization system this feature exists on
     * condition of not becoming — and a scope of its own would have to be
     * granted, which would make the advice something an agent can be *denied*.
     */
    it('travels on a read scope and reaches only a read route', () => {
      expect(TOOL.scope).toBe(MCP_SCOPE.APP_READ);
      expect(SCOPE_TIER[TOOL.scope]).toBe('read');
      expect(TOOL.routes).toEqual(['GET /operating-context/advice']);
    });

    /**
     * The other half of "advice, not a gate": an agent cannot write the rules
     * it will later be handed. Proposing one is a person's screen, not a tool.
     */
    it('publishes no way to write a note', () => {
      const names = OPERATING_CONTEXT_TOOLS.map((t) => t.name);
      expect(names).toEqual(['operating_context_read']);
      const routes = OPERATING_CONTEXT_TOOLS.flatMap((t) => t.routes ?? []);
      expect(routes.every((r) => r.startsWith('GET '))).toBe(true);
    });

    /**
     * A tool nobody registered is a tool no agent is ever handed, and every
     * other row in this file would stay green while it happened — they read the
     * definition, not the catalogue.
     */
    it('is actually published, and first, where an agent will read it', () => {
      expect(ALL_TOOLS[0]).toBe(TOOL);
    });
  });

  describe('a conflict is shown, never settled', () => {
    const conflicted = deliver({
      advice: [
        note({ id: 'platform', scopeType: 'global', scopeRef: null }),
        note({ id: 'app-note', scopeType: 'selector', scopeRef: null }),
      ],
      conflicts: [{ topic: 'deploys', entryIds: ['platform', 'app-note'] }],
    });

    it('hands over every note in the group, so nothing is picked for the model', () => {
      const conflicts = view(conflicted).conflicts as {
        note: string;
        groups: Array<{ topic: string; entryIds: string[] }>;
      };
      expect(conflicts.groups).toEqual([
        { topic: 'deploys', entryIds: ['platform', 'app-note'] },
      ]);
      // Both are still in the advice, at full length: a group of ids pointing
      // at notes the model was not given would be a conflict it cannot report.
      expect(view(conflicted).advice).toHaveLength(2);
    });

    it('tells the model to ask, and tells it the notes are not ranked', () => {
      const conflicts = view(conflicted).conflicts as { note: string };
      expect(conflicts.note).toContain('NOT ranked');
      expect(conflicts.note).toContain('ask');
      expect(conflicts.note).not.toContain('most specific');
    });

    it('says plainly when nothing disagrees, instead of an empty list', () => {
      expect(view(deliver()).conflicts).toContain('none');
    });
  });

  describe('a note carries the state of its own check', () => {
    it('refuses to let a broken premise be followed', () => {
      const broken = view(
        deliver({
          advice: [],
          needsReview: [note({ confidence: 'broken', checkedBy: 'probe' })],
        }),
      );
      expect(broken.needsReview[0].premise).toContain('BROKEN');
      expect(broken.needsReview[0].premise).toContain('no longer true');
      expect(broken.needsReview[0].premise).toContain('Do not follow it');
    });

    it('reads an expired attestation as suspect rather than as true', () => {
      const stale = view(deliver({ advice: [note({ confidence: 'stale' })] }));
      expect(stale.advice[0].premise).toContain('STALE');
      expect(stale.advice[0].premise).toContain('suspect');
    });

    it('keeps a re-read fact and a person’s signature apart', () => {
      const probed = view(
        deliver({
          advice: [note({ confidence: 'checked', checkedBy: 'probe' })],
        }),
      );
      const attested = view(deliver());
      expect(probed.advice[0].premise).toContain(
        're-read from the installation',
      );
      expect(attested.advice[0].premise).toContain('put their name to this');
    });

    it('says when a note was compared with nothing at all', () => {
      const prose = view(
        deliver({
          advice: [note({ confidence: 'unverified', checkedBy: 'none' })],
        }),
      );
      expect(prose.advice[0].premise).toContain('UNVERIFIED');
      expect(prose.advice[0].premise).toContain('not a fact');
    });

    it('gives every note a premise, whichever list it arrives in', () => {
      const both = view(
        deliver({
          advice: [note()],
          needsReview: [note({ id: 'n2', confidence: 'stale' })],
        }),
      );
      for (const entry of [...both.advice, ...both.needsReview]) {
        expect(entry.premise.length).toBeGreaterThan(20);
      }
    });
  });

  describe('what the note says it covers', () => {
    it('names the level in words a model cannot re-interpret', () => {
      const global = view(
        deliver({ advice: [note({ scopeType: 'global', scopeRef: null })] }),
      );
      expect(global.advice[0].appliesTo).toBe('this whole installation');
      expect(view(deliver()).advice[0].appliesTo).toBe('the cluster cluster-1');
    });

    /**
     * The honest answer when the rule really is unknown, and it costs something
     * to give: `intersects` reaches a reader on an over-broad axis, so "this
     * applies to what you are touching" would be a claim nobody had checked.
     * Kept for the case it is true of — a delivery that carries no selector at
     * all — and no longer said of every selector note.
     */
    it('refuses to claim an unnamed selection covers what the agent is touching', () => {
      const selected = view(
        deliver({ advice: [note({ scopeType: 'selector', scopeRef: null })] }),
      );
      expect(selected.advice[0].appliesTo).toContain('do not assume it covers');
    });

    /**
     * The delivery carries the rule; the description used to say it did not. A
     * false description handed to an agent is worse than a missing one — the
     * model reasons over it, and this one told it to distrust a field sitting
     * in the same object.
     */
    it('spells out the rule a selector note is written on', () => {
      const selected = view(
        deliver({
          advice: [
            note({
              scopeType: 'selector',
              scopeRef: null,
              selector: { slugs: ['api', 'worker'], provider: 'hetzner' },
              pinnedToAnOwner: false,
            }),
          ],
        }),
      );
      expect(selected.advice[0].appliesTo).toContain('api, worker');
      expect(selected.advice[0].appliesTo).toContain('hetzner');
      expect(selected.advice[0].appliesTo).not.toContain('do not assume');
    });

    /**
     * The cross-check the description now has to pass: what the tool reads is
     * what `selectorForAgent` — the function `forAgent` builds `AdviceEntry`
     * with — actually emits, under those key names and with `owner` already
     * gone. Rename a field on either side and this row goes red.
     */
    it('reads the selector under the names the delivery really uses', () => {
      const asDelivered = selectorForAgent({
        slugs: ['api'],
        owner: 'user-9',
      });
      const selected = view(
        deliver({
          advice: [
            note({ scopeType: 'selector', scopeRef: null, ...asDelivered }),
          ],
        }),
      );
      expect(selected.advice[0].appliesTo).toContain('api');
      expect(selected.advice[0].appliesTo).not.toContain('user-9');
    });

    /**
     * The trap decision 160 named. A note pinned to one principal reaches here
     * with every axis withheld, and an empty rule reads as *this applies to
     * everything* — a wider claim than the note makes.
     */
    it('never turns a note pinned to one principal into a rule about everything', () => {
      const asDelivered = selectorForAgent({ owner: 'user-9' });
      expect(asDelivered.selector).toBeNull();
      const selected = view(
        deliver({
          advice: [
            note({ scopeType: 'selector', scopeRef: null, ...asDelivered }),
          ],
        }),
      );
      expect(selected.advice[0].appliesTo).toContain('one principal');
      expect(selected.advice[0].appliesTo).not.toContain('user-9');
      expect(selected.advice[0].appliesTo).not.toContain(
        'this whole installation',
      );
    });

    it('puts no unreadable value into a model’s context', () => {
      const selected = view(
        deliver({
          advice: [
            note({
              scopeType: 'selector',
              scopeRef: null,
              selector: { kind: { nested: true } },
            }),
          ],
        }),
      );
      expect(selected.advice[0].appliesTo).not.toContain('[object Object]');
    });
  });

  describe('an empty answer', () => {
    it('says nothing was written down, rather than letting the model infer one', () => {
      const empty = view(deliver({ advice: [] }));
      expect(empty.note).toContain('Nobody has written down');
      expect(empty.note).toContain('not permission to assume');
    });

    it('adds no such note when there is advice to read', () => {
      expect(view(deliver()).note).toBeUndefined();
    });

    it('survives an answer that carries none of the fields', () => {
      expect(() => view({})).not.toThrow();
      expect(view({}).advice).toEqual([]);
    });
  });

  describe('the focus the agent is acting under', () => {
    it('passes what it was given and leaves the rest out', async () => {
      const calls: Recorded[] = [];
      await TOOL.run(
        { slug: 'my-api', tags: ['edge', 'public'] } as never,
        ctxFor(deliver(), calls),
      );
      expect(calls[0].path).toBe('/operating-context/advice');
      expect(calls[0].query).toMatchObject({
        slug: 'my-api',
        // Comma-joined, because that is how the route reads it back.
        tags: 'edge,public',
        clusterId: undefined,
      });
    });

    it('asks for everything that reaches it when told nothing', async () => {
      const calls: Recorded[] = [];
      await TOOL.run({} as never, ctxFor(deliver(), calls));
      const query = calls[0].query as Record<string, unknown>;
      expect(Object.values(query).every((v) => v === undefined)).toBe(true);
    });

    it('rejects an argument name it does not publish', () => {
      const schema = toolInputSchema(TOOL.inputSchema);
      expect(schema.safeParse({ application: 'my-api' }).success).toBe(false);
      expect(schema.safeParse({ slug: 'my-api' }).success).toBe(true);
    });

    /**
     * `owner` is a field of the focus and is deliberately not published. It
     * narrows by *whose* the thing is, which is a question about the reader's
     * own grant rather than about what is being acted on — and an agent that
     * could pass it would be filtering advice by ownership, which is precisely
     * the restriction rule 1 refuses.
     */
    it('publishes no way to filter the advice by owner', () => {
      expect(Object.keys(TOOL.inputSchema)).not.toContain('owner');
    });
  });

  /**
   * The reason this pair was built together. A guest of the demonstration acts
   * on a real cluster it did not configure, so it is the reader with the most
   * to gain from the local practice and the least other way of learning it.
   */
  describe('a sandbox guest reaches it', () => {
    it('is offered to a guest’s agent, because the fence answers it for real', () => {
      expect(sandboxLevelOf('GET', '/operating-context/advice')).toBe(
        'read-only',
      );
      expect(
        findSandboxStandIn('GET', '/operating-context/advice'),
      ).toBeUndefined();
      expect(isOfferedToGuest(TOOL)).toBe(true);
    });

    it('reads the notes and writes none of them', () => {
      expect(isSandboxAllowed('GET', '/operating-context')).toBe(true);
      expect(isSandboxAllowed('POST', '/operating-context')).toBe(false);
      expect(isSandboxAllowed('PATCH', '/operating-context/n1')).toBe(false);
      expect(isSandboxAllowed('DELETE', '/operating-context/n1')).toBe(false);
      expect(isSandboxAllowed('POST', '/operating-context/n1/confirm')).toBe(
        false,
      );
    });
  });
});
