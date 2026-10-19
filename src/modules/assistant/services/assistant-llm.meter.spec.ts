const guardedRequest = jest.fn();
jest.mock('../../../common/net/egress-guard', () => ({
  guardedRequest: (...args: unknown[]) => guardedRequest(...args),
}));
jest.mock('../../inference/services/inference-usage.service', () => ({
  InferenceUsageService: class InferenceUsageService {},
}));

import {
  AssistantLlmService,
  cachedPromptTokens,
} from './assistant-llm.service';

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

  // Scaleway reports the cached share the OpenAI way; the ledger keeps it so the
  // bill can be priced at the cached rate.
  it('keeps the share of the prompt the provider served from its cache', async () => {
    const { service, recorded } = build();
    guardedRequest.mockResolvedValue({
      data: {
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: {
          prompt_tokens: 41313,
          completion_tokens: 199,
          total_tokens: 41512,
          prompt_tokens_details: {
            cached_tokens: 24576,
            created_cache_tokens: 0,
          },
        },
      },
    });

    await service.chat(
      endpoint({ userId: 'u1', guest: false, surface: 'assistant' }) as never,
      request,
    );

    expect(recorded[0]).toMatchObject({
      promptTokens: 41313,
      cachedPromptTokens: 24576,
    });
  });

  it('reads the cached share from the other shapes providers use', () => {
    const base = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
    expect(cachedPromptTokens(undefined)).toBe(0);
    expect(cachedPromptTokens(base)).toBe(0);
    expect(
      cachedPromptTokens({
        ...base,
        prompt_tokens_details: { cached_tokens: null },
      }),
    ).toBe(0);
    expect(cachedPromptTokens({ ...base, prompt_cache_hit_tokens: 7 })).toBe(7);
    expect(cachedPromptTokens({ ...base, cache_read_input_tokens: 5 })).toBe(5);
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
