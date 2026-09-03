import { readFileSync } from 'fs';
import { join } from 'path';
import { chatActionRequest, reachesActionCycle } from './action-cycle-reach';
import {
  ESTIMATE_WITHHELD_NOTE,
  ProposalRefusal,
} from '../../action-cycle/action-cycle.core';
import { ALL_TOOLS } from '../../mcp/tools/tool-registry';
import { SCOPE_TIER } from '../../mcp/constants/mcp-scopes';

const decorated = new Set([
  'POST /applications/:id/deploy',
  'POST /infrastructure/clusters/:id/stop',
  'POST /infrastructure/clusters/:id/start',
]);

const refusal: ProposalRefusal = {
  proposalId: 'p-1',
  action: 'POST /applications/:id/deploy',
  sentence: 'deploy application app-1 whenever it asks',
  offersAlways: false,
  decideUrl: 'https://console.test/agents/requests/p-1',
  estimateWithheld: false,
};

/**
 * The question the chat has to answer before it calls anything: may this call
 * be made now, on the strength of the guard refusing it?
 */
describe('which of the chat’s calls the cycle will stop', () => {
  it('admits a tool only when every route it can land on is inside the cycle', () => {
    expect(
      reachesActionCycle(['POST /applications/:id/deploy'], decorated),
    ).toBe(true);
    expect(
      reachesActionCycle(
        [
          'POST /infrastructure/clusters/:id/stop',
          'POST /infrastructure/clusters/:id/start',
        ],
        decorated,
      ),
    ).toBe(true);
  });

  /**
   * `every`, not `some`, and the reason is a real tool: `cluster_power` names
   * both stop and start and picks between them inside its body. A predicate
   * that accepted "one of them pauses" would let the other branch run before
   * anybody was asked.
   */
  it('refuses a tool that can branch onto a route outside the cycle', () => {
    expect(
      reachesActionCycle(
        [
          'POST /infrastructure/clusters/:id/stop',
          'POST /applications/:id/restart',
        ],
        decorated,
      ),
    ).toBe(false);
  });

  it('fails closed on a tool that declares nothing', () => {
    // A wrong `false` costs the chat's old card. A wrong `true` costs a write
    // performed before anybody was asked, so silence has to mean no.
    expect(reachesActionCycle(undefined, decorated)).toBe(false);
    expect(reachesActionCycle([], decorated)).toBe(false);
  });

  it('compares whole shapes, never prefixes', () => {
    expect(reachesActionCycle(['POST /applications/:id'], decorated)).toBe(
      false,
    );
    expect(
      reachesActionCycle(['GET /applications/:id/deploy'], decorated),
    ).toBe(false);
  });
});

describe('what the person confirming in the chat is shown', () => {
  it('carries the cycle’s sentence verbatim', () => {
    expect(chatActionRequest(refusal).sentence).toBe(refusal.sentence);
  });

  it('points at the request it will answer, so the click lands on that one', () => {
    const shown = chatActionRequest(refusal);
    expect(shown.proposalId).toBe('p-1');
    expect(shown.decideUrl).toBe(refusal.decideUrl);
  });

  /**
   * One sentence for one fact. The MCP refusal and the assistant's wait already
   * say it; a third wording on the card would be a third promise about the same
   * missing figure.
   */
  it('says a price is attached in the product’s own words, and stays silent otherwise', () => {
    expect(
      chatActionRequest({ ...refusal, estimateWithheld: true }).estimateNote,
    ).toBe(ESTIMATE_WITHHELD_NOTE);
    expect(chatActionRequest(refusal).estimateNote).toBeUndefined();
  });

  it('never carries the pricing route itself', () => {
    const shown = chatActionRequest({ ...refusal, estimateWithheld: true });
    expect(JSON.stringify(shown)).not.toContain('capacity-plan');
  });
});

/**
 * The predicate is only worth anything if the loop asks it where it matters,
 * and neither service below can be imported here — both pull the Kubernetes
 * client down their tree and the runner refuses it. So the three call sites
 * are checked the way the route sentinels check theirs, by reading the
 * source. Brittle on purpose: the defect this round closes is a rule that
 * was built, proved and reached by nobody.
 */
describe('the loop that has to ask it', () => {
  const pendingSource = readFileSync(
    join(__dirname, 'assistant-pending-actions.service.ts'),
    'utf8',
  );
  const executionSource = readFileSync(
    join(__dirname, 'assistant-tool-execution.service.ts'),
    'utf8',
  );

  it('raises the request before the card is built, not after the click', () => {
    const collect = pendingSource.slice(
      pendingSource.indexOf('async collectPending'),
    );
    const body = collect.slice(
      0,
      collect.indexOf('private async raiseRequest'),
    );
    expect(body).toContain('this.raiseRequest(');
    // The card carries what the raise came back with. Pinned by the field it
    // is read out of, not by a bare `request,` that any shape would satisfy.
    expect(body).toContain('request: answer?.request,');
  });

  it('answers for the person only where the request was shown to them', () => {
    // Same predicate on both sides. If the assent could be given on a call the
    // card never carried a request for, the round would have moved the defect
    // rather than closed it. This one lives in AssistantToolExecutionService's
    // callTool — the retry after the person assents in chat — not in the
    // request-raising service above.
    const branch = executionSource.slice(
      executionSource.indexOf('const answered ='),
    );
    const condition = branch.slice(0, branch.indexOf(';'));
    expect(condition).toContain('this.cycleRoutes.reaches(def.routes)');
    expect(condition).toContain('assentInChat(');
  });

  it('raises nothing for a tool the cycle does not look at', () => {
    const raise = pendingSource.slice(
      pendingSource.indexOf('private async raiseRequest'),
    );
    const guard = raise.slice(0, raise.indexOf('\n', raise.indexOf('return')));
    expect(guard).toContain('!this.cycleRoutes.reaches(def.routes)');
  });
});

/**
 * The join only works because both halves are written in the same grammar. This
 * is the cheap check that they still are — a tool whose declared route is a
 * prefix or a near-miss of a decorated one would silently drop out of the
 * predicate and take its request with it.
 */
describe('the two halves of the join', () => {
  it('declares every write tool’s route as a whole verb-and-pattern shape', () => {
    const shapes = ALL_TOOLS.filter(
      (t) =>
        SCOPE_TIER[t.scope] === 'write' ||
        SCOPE_TIER[t.scope] === 'destructive',
    ).flatMap((t) => t.routes ?? []);
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(shape).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/[^ ]*$/);
    }
  });
});
