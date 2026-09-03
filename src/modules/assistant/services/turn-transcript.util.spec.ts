import { readFileSync } from 'fs';
import { join } from 'path';
import {
  answeredToolCallIds,
  unansweredToolCalls,
} from './turn-transcript.util';
import { ChatCompletionMessage } from '../interfaces/chat-completion';

const call = (id: string, name = 'app_scale') => ({
  id,
  type: 'function' as const,
  function: { name, arguments: '{"id":"app-1"}' },
});

const user = (content: string): ChatCompletionMessage => ({
  role: 'user',
  content,
});

const proposes = (...ids: string[]): ChatCompletionMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: ids.map((id) => call(id)),
});

const answers = (
  id: string,
  content = '{"ok":true}',
): ChatCompletionMessage => ({
  role: 'tool',
  tool_call_id: id,
  content,
});

/**
 * The rule this replaces was "the last message is an assistant message with
 * tool_calls". It gave the right answer for every turn that answered all of its
 * calls or none of them — and the action cycle's own middle answer made a turn
 * that answers some.
 */
describe('what a resume still has to decide', () => {
  it('is nothing on a fresh turn', () => {
    expect(unansweredToolCalls([user('scale my app')])).toEqual([]);
    expect(unansweredToolCalls([])).toEqual([]);
  });

  it('is every call of a turn that stopped to confirm', () => {
    const turn = [user('scale my app'), proposes('a', 'b')];
    expect(unansweredToolCalls(turn).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('is only the calls the transcript does not already answer', () => {
    const turn = [user('scale my app'), proposes('a', 'b'), answers('a')];
    expect(unansweredToolCalls(turn).map((c) => c.id)).toEqual(['b']);
  });

  it('is nothing once every call of the round is answered', () => {
    const turn = [
      user('scale my app'),
      proposes('a', 'b'),
      answers('a'),
      answers('b'),
      { role: 'assistant' as const, content: 'done' },
    ];
    expect(unansweredToolCalls(turn)).toEqual([]);
  });

  it('never re-offers an earlier round of the same conversation', () => {
    // The finished round is finished business: handing its calls back would
    // run them a second time, which is the failure this file exists to stop.
    const turn = [
      user('scale my app'),
      proposes('a'),
      answers('a'),
      { role: 'assistant' as const, content: 'done' },
      user('now restart it'),
      proposes('b'),
    ];
    expect(unansweredToolCalls(turn).map((c) => c.id)).toEqual(['b']);
  });

  it('reads the ids off tool messages and nothing else', () => {
    const ids = answeredToolCallIds([
      proposes('a'),
      answers('a'),
      { role: 'assistant', content: 'x', tool_call_id: 'b' },
      { role: 'tool', content: 'orphan' },
    ]);
    expect([...ids]).toEqual(['a']);
  });
});

/**
 * The loop cannot be imported here (it pulls the Kubernetes client down its
 * tree and the runner refuses it), so the two places that have to use this are
 * pinned by reading the source — the same way the other rules of this surface
 * are. Brittle on purpose: a rule nobody calls is precisely the defect this
 * series has met six times.
 */
describe('the turn that has to decide a resume from the transcript', () => {
  const source = readFileSync(
    join(__dirname, 'assistant-agent.service.ts'),
    'utf8',
  );

  it('decides a resume from the transcript, not from the last message', () => {
    expect(source).toContain('unansweredToolCalls(conversation)');
    expect(source).not.toContain("tail?.role === 'assistant'");
  });
});

/**
 * Same rule, moved with the tool-dispatch loop itself into
 * AssistantToolExecutionService — see that file's own resolveToolCalls.
 */
describe('the loop that has to write the settled call down', () => {
  const source = readFileSync(
    join(__dirname, 'assistant-tool-execution.service.ts'),
    'utf8',
  );

  it('writes a settled call into the conversation before it returns a card', () => {
    const body = source.slice(source.indexOf('const settledIds = new Set'));
    const early = body.slice(0, body.indexOf('if (pending.length) return'));
    expect(early).toContain('steps.push(');
    expect(early).toContain('conversation.push(');
  });

  it('does not run a settled call a second time in the same turn', () => {
    const loop = source.slice(source.indexOf('const settledIds = new Set'));
    const body = loop.slice(loop.indexOf('for (const tc of toolCalls)'));
    expect(body.slice(0, body.indexOf('execOrDeny'))).toContain(
      'settledIds.has(tc.id)',
    );
  });
});
