import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AGENT_STANDING_REFUSAL_PREFIX,
  AGENT_WAIT_PREFIX,
  assentInChat,
  didNotTakeEffect,
  isStandingRefusal,
  isWaitingOnPerson,
  proposalRefusalOf,
  standingRefusalMessage,
  waitMessage,
  waitingAuditRow,
} from './agent-pause.util';
import { McpApiCaller, McpApiError } from '../../mcp/services/mcp-api.client';
import {
  ACTION_PROPOSAL_CODE,
  ACTION_PROPOSAL_DENIED_CODE,
} from '../../action-cycle/action-cycle.core';

const refusal = {
  proposalId: 'p-1',
  action: 'POST /applications/:id/deploy',
  sentence: 'deploy application app-1 whenever it asks',
  offersAlways: true,
  decideUrl: 'https://console.test/agents/requests/p-1',
  estimateWithheld: false,
};

const pending = () =>
  new McpApiError(
    403,
    'This call needs a person to allow it first.',
    'POST',
    '/applications/app-1/deploy',
    ACTION_PROPOSAL_CODE,
    undefined,
    refusal,
  );

function caller(post: jest.Mock): McpApiCaller {
  return {
    get: jest.fn(),
    post,
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  } as unknown as McpApiCaller;
}

/**
 * How the portal's assistant meets the action cycle — the half that can be
 * proved without standing the agent loop up, which is the whole reason it lives
 * outside it.
 */
describe('a request raised against the assistant', () => {
  it('is recognised only as the cycle asking, never as a failure', () => {
    expect(proposalRefusalOf(pending())?.proposalId).toBe('p-1');
    expect(
      proposalRefusalOf(
        new McpApiError(403, 'Not allowed', 'POST', '/x', 'FORBIDDEN'),
      ),
    ).toBeUndefined();
    expect(proposalRefusalOf(new Error('boom'))).toBeUndefined();
    expect(proposalRefusalOf(undefined)).toBeUndefined();
  });

  it('tells the model it is a wait, in the sentence the person will read', () => {
    const message = waitMessage(refusal);
    expect(message).toContain(refusal.sentence);
    expect(message).toContain(refusal.decideUrl);
    expect(message).toContain('NOTHING was changed');
  });

  /**
   * The other half of the same defect the register had: the price reaches the
   * panel and not the model, so an agent reports "I asked to add a node" and
   * the person hears nothing about a cost. The route that serves the estimate
   * stays behind the guard — a path is a call this surface cannot make either.
   */
  it('says a price is attached when one is, without naming its route', () => {
    const priced = waitMessage({ ...refusal, estimateWithheld: true });
    expect(priced).toContain('cost estimate attached');
    expect(priced).not.toContain('capacity-plan');
    expect(waitMessage(refusal)).not.toContain('cost estimate attached');
  });

  /**
   * Both halves of a stopped turn, written together. Split, this surface wrote
   * `allowed: true, outcome: null` and the register read it as "started
   * nothing" — the opposite fact.
   */
  it('leaves the register a wait, not a call that did nothing', () => {
    expect(waitingAuditRow(refusal)).toEqual({
      outcome: 'input_required',
      proposalId: 'p-1',
    });
    expect(waitingAuditRow()).toEqual({
      outcome: null,
      proposalId: null,
    });
  });

  it('is recognisable as a wait and as nothing else', () => {
    expect(isWaitingOnPerson(waitMessage(refusal))).toBe(true);
    expect(isWaitingOnPerson(`  ${AGENT_WAIT_PREFIX}: …`)).toBe(true);
    expect(isWaitingOnPerson('{"applications":[]}')).toBe(false);
    expect(isWaitingOnPerson('Error: unknown tool')).toBe(false);
  });

  it('reads back as "nothing happened", so the person can still allow it', () => {
    // The transcript is how the loop rebuilds what already ran, and it refuses
    // to run a write twice. A wait that read as done would make the resume
    // refuse the very call the person just allowed — the regression this whole
    // change had to avoid.
    expect(didNotTakeEffect(waitMessage(refusal))).toBe(true);
  });

  it('still counts every refusal it counted before', () => {
    expect(didNotTakeEffect('DENIED by the user — nothing changed')).toBe(true);
    expect(didNotTakeEffect('Refused: missing required scope')).toBe(true);
    expect(didNotTakeEffect('Error: invalid arguments')).toBe(true);
  });

  it('leaves a real result alone, so a write is never run twice', () => {
    expect(didNotTakeEffect('{"operationId":"op-1","status":"PENDING"}')).toBe(
      false,
    );
    expect(
      didNotTakeEffect('Started — it runs in the background and the user…'),
    ).toBe(false);
  });
});

describe('the person answering in the chat', () => {
  it('answers the request that was actually raised, and only once', async () => {
    const post = jest.fn().mockResolvedValue({});
    expect(await assentInChat(caller(post), refusal)).toBe(true);
    expect(post).toHaveBeenCalledWith('/agent/proposals/p-1/decide', {
      decision: 'once',
    });
  });

  it('goes through the decision route, not the service behind it', async () => {
    // That route is where an agent is refused the approver's pen. A chat driven
    // by an agent credential is refused there exactly as it would be at the
    // panel, and the wait stands.
    const post = jest
      .fn()
      .mockRejectedValue(
        new McpApiError(403, 'agent', 'POST', '/agent/proposals/p-1/decide'),
      );
    expect(await assentInChat(caller(post), refusal)).toBe(false);
  });

  it('leaves the wait standing when the question has expired', async () => {
    const post = jest.fn().mockRejectedValue(new Error('expired'));
    expect(await assentInChat(caller(post), refusal)).toBe(false);
  });
});

/**
 * The cycle's other answer to the same question — and the one both surfaces
 * used to present as something else entirely.
 */
describe('a refusal that already stands', () => {
  const denied = () =>
    new McpApiError(
      403,
      'This exact call was refused by the person you act for, and the answer stands.',
      'DELETE',
      '/applications/app-1',
      ACTION_PROPOSAL_DENIED_CODE,
    );

  it('is told apart from an access refusal, which is also a 403', () => {
    expect(isStandingRefusal(denied())).toBe(true);
    expect(
      isStandingRefusal(
        new McpApiError(403, 'Not allowed', 'DELETE', '/applications/app-1'),
      ),
    ).toBe(false);
    expect(
      isStandingRefusal(
        new McpApiError(403, 'Not allowed', 'DELETE', '/x', 'FORBIDDEN'),
      ),
    ).toBe(false);
  });

  it('is not mistaken for the cycle asking, and asking is not mistaken for it', () => {
    expect(proposalRefusalOf(denied())).toBeUndefined();
    expect(isStandingRefusal(pending())).toBe(false);
  });

  it('is fail-closed on everything that is not an API refusal', () => {
    expect(isStandingRefusal(new Error('boom'))).toBe(false);
    expect(isStandingRefusal(undefined)).toBe(false);
    expect(isStandingRefusal({ code: ACTION_PROPOSAL_DENIED_CODE })).toBe(
      false,
    );
  });

  it('reads as "nothing happened" in the transcript, like the wait does', () => {
    // The loop rebuilds what already ran from the tool messages. A settled no
    // is a call that did not run, and a transcript that read it as done would
    // hide a delete that never happened behind "already done".
    expect(didNotTakeEffect(standingRefusalMessage('refused.'))).toBe(true);
    expect(standingRefusalMessage('refused.')).toContain(
      AGENT_STANDING_REFUSAL_PREFIX,
    );
  });

  it('tells the model the opposite of what a wait tells it', () => {
    const message = standingRefusalMessage('refused.');
    expect(message).toContain('Do NOT retry');
    expect(message).toContain('do NOT reword');
    expect(message).not.toContain(AGENT_WAIT_PREFIX);
    // A wait says to retry the identical call; these two must never be one
    // sentence with a flag, or a model reading either would do the other.
    expect(waitMessage(refusal)).not.toContain('Do NOT retry');
  });

  it("carries the API's own words rather than rewording the refusal", () => {
    expect(standingRefusalMessage('the person said no.')).toContain(
      'the person said no.',
    );
  });
});

/**
 * The one thing a unit test of this file cannot reach: whether the loop calls
 * it.
 *
 * `assistant-agent.service.ts` cannot be imported here — it pulls the
 * Kubernetes client down its tree and the runner refuses it, which is why the
 * rules live in this file at all. So the caller is checked the way the route
 * sentinels check theirs: by reading the source. Brittle on purpose. The defect
 * it stands against is the one this round exists to close — a rule built,
 * proved and reached by nobody — and it had already happened once here, with
 * the wait recorded as a turn that started nothing.
 */
describe('the loop that has to hand the wait over', () => {
  const source = readFileSync(
    join(__dirname, 'assistant-agent.service.ts'),
    'utf8',
  );

  it('records the refusal itself, not just the words it turned into', () => {
    const branch = source.slice(source.indexOf('const message = waitMessage('));
    const call = branch.slice(0, branch.indexOf('steps.push('));
    expect(call).toContain('this.recordTool(');
    expect(call).toContain('waiting: refusal');
  });

  it('derives both columns from the same helper, in one place', () => {
    expect(source).toContain('waitingAuditRow(call?.waiting)');
    // Not a second, hand-rolled copy of the same two fields somewhere else.
    expect(source.match(/input_required/g)).toBeNull();
  });

  it('never offers a card for a call the cycle has already refused', () => {
    // The chat's own confirmation is driven by the tool's tier, so without this
    // branch a settled no is followed by "Confirm delete".
    const raise = source.slice(source.indexOf('private async raiseRequest'));
    const body = raise.slice(0, raise.indexOf('private async describePending'));
    expect(body).toContain('isStandingRefusal(error)');
    expect(body).toContain('standingRefusalMessage(');
    expect(body).toContain("kind: 'settled'");
  });

  it('records a settled refusal the way the MCP surface records it', () => {
    const branch = source.slice(
      source.indexOf('if (isStandingRefusal(error))'),
    );
    const call = branch.slice(0, branch.indexOf('return {'));
    // `allowed: false` — the scope handed the tool over and the cycle refused
    // the call. Two surfaces disagreeing about that is the register lying.
    expect(call).toContain('def, false, message');
  });
});

/**
 * The half the estimate field kept standing in for.
 *
 * `sentence` says what was asked for; `consequence` says what it does. Six
 * routes had been pointing `estimate` at a plain listing to cover the second
 * question, which told the person there was a price to read and told the agent,
 * in so many words, that the action had one. Both surfaces now carry the
 * sentence instead, and both are pinned here because the failure this closes
 * was two surfaces answering the same fact differently.
 */
describe('what happens if the person says yes', () => {
  const refusal = (consequence?: string) => ({
    proposalId: 'p1',
    action: 'POST /things/:id/go',
    sentence: 'do the thing',
    offersAlways: false,
    estimateWithheld: false,
    consequence,
  });

  it('reaches the chat when the route declared it', () => {
    expect(waitMessage(refusal('Servers start being billed.'))).toContain(
      'If allowed: Servers start being billed.',
    );
  });

  it('says nothing extra when the route declared nothing', () => {
    expect(waitMessage(refusal())).not.toContain('If allowed:');
  });
});
