import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import {
  AssistantGuardService,
  parseRouterIds,
  routerReasoningEffort,
} from './assistant-guard.service';
import { AssistantLlmService } from './assistant-llm.service';

const endpoint = {
  baseUrl: 'https://inference.invalid/v1',
} as unknown as InferenceEndpoint;

function guardAnswering(content: string | null) {
  const chat = jest.fn().mockResolvedValue({
    choices: [{ message: { role: 'assistant', content } }],
  });
  const guard = new AssistantGuardService({
    chat,
  } as unknown as AssistantLlmService);
  return { guard, chat };
}

const ask = [{ role: 'user', content: 'How do I add a node?' }];

describe('the router of the Flui Assistant', () => {
  it('leaves a reasoning model room to think before it answers', async () => {
    const { guard, chat } = guardAnswering('concepts/04-creating-a-cluster');
    await guard.route(endpoint, 'gpt-oss-120b', ask, 'index');
    expect(chat.mock.calls[0][1].max_tokens).toBeGreaterThanOrEqual(512);
  });

  it('asks gpt-oss for low reasoning and deepseek for none', async () => {
    const { guard, chat } = guardAnswering('cli/clusters-and-nodes');
    await guard.route(endpoint, 'gpt-oss-120b', ask, 'index');
    await guard.route(endpoint, 'deepseek-v4-flash-0731', ask, 'index');
    expect(chat.mock.calls[0][1].reasoning_effort).toBe('low');
    expect(chat.mock.calls[1][1].reasoning_effort).toBe('none');
  });

  it('sends no reasoning parameter to a model that does not reason', async () => {
    const { guard, chat } = guardAnswering('cli/clusters-and-nodes');
    await guard.route(
      endpoint,
      'mistral-small-3.2-24b-instruct-2506',
      ask,
      'index',
    );
    expect(chat.mock.calls[0][1]).not.toHaveProperty('reasoning_effort');
    expect(routerReasoningEffort('mistral-small-2603')).toBeUndefined();
  });

  it('returns no ids, not a refusal, when the model spent its budget and said nothing', async () => {
    const { guard } = guardAnswering(null);
    await expect(
      guard.route(endpoint, 'gpt-oss-120b', ask, 'index'),
    ).resolves.toEqual({ offTopic: false, sectionIds: [] });
  });

  it('still gates an off-topic request', async () => {
    const { guard } = guardAnswering('OFF_TOPIC');
    await expect(
      guard.route(endpoint, 'gpt-oss-120b', ask, 'index'),
    ).resolves.toEqual({ offTopic: true, sectionIds: [] });
  });

  it('reads ids out of the decorations models put around them', () => {
    expect(
      parseRouterIds(
        '`concepts/16-the-app-concept`, "cli/applications".\n- tasks/deploy-an-application',
      ),
    ).toEqual([
      'concepts/16-the-app-concept',
      'cli/applications',
      'tasks/deploy-an-application',
    ]);
  });
});
