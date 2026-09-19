const guardedRequest = jest.fn();
jest.mock('../../../common/net/egress-guard', () => ({
  guardedRequest: (...args: unknown[]) => guardedRequest(...args),
}));
jest.mock('../../inference/services/inference-usage.service', () => ({
  InferenceUsageService: class InferenceUsageService {},
}));

import { AssistantLlmService } from './assistant-llm.service';

const build = () => {
  const recorded: Record<string, unknown>[] = [];
  const paramPolicy = {
    apply: (_url: string, req: unknown) => req,
    learn: () => undefined,
  };
  const usage = {
    record: async (r: Record<string, unknown>) => {
      recorded.push(r);
    },
  };
  return {
    recorded,
    service: new AssistantLlmService(paramPolicy as never, usage as never),
  };
};

const endpoint = (spender?: unknown) => ({
  baseUrl: 'https://provider.example/v1',
  apiKey: 'k',
  spender,
});

const request = {
  model: 'model-a',
  messages: [{ role: 'user', content: 'hello' }],
} as never;

describe('who gets billed for a call', () => {
  beforeEach(() => guardedRequest.mockReset());

  it('writes a row against the person who spent it', async () => {
    const { service, recorded } = build();
    guardedRequest.mockResolvedValue({
      data: {
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      },
    });

    await service.chat(
      endpoint({ userId: 'u1', guest: true, surface: 'assistant' }) as never,
      request,
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      userId: 'u1',
      guest: true,
      surface: 'assistant',
      model: 'model-a',
      promptTokens: 11,
      completionTokens: 7,
      estimated: false,
    });
  });

  // The platform calling on its own behalf — the on-topic router, a background
  // job — is not somebody's bill.
  it('bills nobody when the endpoint names no spender', async () => {
    const { service, recorded } = build();
    guardedRequest.mockResolvedValue({
      data: { choices: [{ message: { role: 'assistant', content: 'hi' } }] },
    });

    await service.chat(endpoint() as never, request);

    expect(recorded).toHaveLength(0);
  });

  /**
   * A provider that reports nothing must still move the budget, or the meter
   * reads zero for exactly the calls it was built to catch.
   */
  it('measures the text when the provider reports no counts, and says it guessed', async () => {
    const { service, recorded } = build();
    guardedRequest.mockResolvedValue({
      data: {
        choices: [{ message: { role: 'assistant', content: 'x'.repeat(40) } }],
      },
    });

    await service.chat(
      endpoint({ userId: 'u1', guest: true, surface: 'assistant' }) as never,
      request,
    );

    expect(recorded[0].estimated).toBe(true);
    expect(recorded[0].promptTokens as number).toBeGreaterThan(0);
    expect(recorded[0].completionTokens).toBe(10);
  });
});
