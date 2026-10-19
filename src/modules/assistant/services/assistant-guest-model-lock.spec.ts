jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('../../inference/services/inference-resolver.service', () => ({
  InferenceResolverService: class InferenceResolverService {},
}));
jest.mock('../../inference/services/inference-client.service', () => ({
  InferenceClientService: class InferenceClientService {},
}));

import { AssistantInferenceService } from './assistant-inference.service';
import { AssistantAgentService } from './assistant-agent.service';
import { AssistantService } from './assistant.service';
import { GuestInferenceGuardService } from './guest-inference-guard.service';
import { guestInferenceLimits } from './guest-inference-limits';
import { AgentRequestDto } from '../dto/agent-request.dto';
import { ChatCompletionRequestDto } from '../dto/chat-completion-request.dto';
import { IdentityRole } from '../../auth/entities/user.entity';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import { DbAssistService } from '../../database-console/services/db-assist.service';
import { KafkaAssistService } from '../../database-console/services/kafka-assist.service';
import { DocumentAssistService } from '../../database-console/services/document-assist.service';
import { SearchAssistService } from '../../database-console/services/search-assist.service';
import { FulltextAssistService } from '../../database-console/services/fulltext-assist.service';
import { KvAssistService } from '../../database-console/services/kv-assist.service';
import { isSandboxAllowed } from '../../sandbox/constants/sandbox-fence';

/**
 * Every path a sandbox guest can spend inference through, each one asked for a
 * different model, provider and connection, and each one answered with the
 * model the instance pinned. The unit spec of `AssistantInferenceService`
 * proves the rule; this one proves that no surface goes around it.
 */
const PINNED = 'pinned-model';
const INSTANCE = {
  baseUrl: 'https://instance.example/v1',
  apiKey: 'instance-key',
  defaultModel: 'instance-default',
};
const ELSEWHERE = {
  baseUrl: 'https://elsewhere.example/v1',
  apiKey: 'other-key',
  defaultModel: 'expensive',
};

const asked = {
  model: 'an-expensive-one',
  provider: CloudProvider.SCALEWAY,
  connectionId: 'someone-elses-connection',
};

const guest: AuthenticatedUser = {
  userId: 'guest-a',
  email: 'guest-a@try.example',
  roles: {},
  role: IdentityRole.USER,
  isAdmin: false,
};

function inferenceFor(over: { pinned?: string; endpointDefault?: boolean }) {
  const config = {
    get: (key: string) =>
      ({ SANDBOX_ASSISTANT_MODEL: over.pinned })[key] as string | undefined,
  };
  const usage = { tokensFor: async () => 0 };
  const resolver = {
    resolveDefault: async () =>
      over.endpointDefault === false
        ? { baseUrl: INSTANCE.baseUrl, apiKey: INSTANCE.apiKey }
        : INSTANCE,
    resolveNative: async () => ELSEWHERE,
    resolveConnection: async () => ELSEWHERE,
  };
  const antifraud = new GuestInferenceGuardService(
    {
      limits: async () =>
        guestInferenceLimits((key) => config.get(key) as string | undefined),
    } as never,
    usage as never,
    {} as never,
    {} as never,
    config as never,
  );
  return new AssistantInferenceService(
    resolver as never,
    { listModelIds: async () => ['first-listed'] } as never,
    config as never,
    { resolveAccess: async () => ({ isSandbox: true }) } as never,
    {
      findOne: async () => ({
        id: guest.userId,
        email: guest.email,
        role: 'user',
        isAdmin: false,
        kind: 'visitor',
      }),
    } as never,
    usage as never,
    antifraud,
  );
}

const CAPTURED = 'captured';

function capturingLlm() {
  const calls: { endpoint: InferenceEndpoint; model: string }[] = [];
  const capture = async (
    endpoint: InferenceEndpoint,
    req: { model: string },
  ) => {
    calls.push({ endpoint, model: req.model });
    throw new Error(CAPTURED);
  };
  return { calls, llm: { chat: capture, chatStream: capture } };
}

function expectPinned(
  calls: { endpoint: InferenceEndpoint; model: string }[],
  model = PINNED,
) {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.model).toBe(model);
    expect(call.endpoint.apiKey).toBe(INSTANCE.apiKey);
    expect(call.endpoint.spender?.guest).toBe(true);
  }
}

function agentWith(inference: AssistantInferenceService) {
  const models: string[] = [];
  const endpoints: InferenceEndpoint[] = [];
  const guard = {
    route: jest.fn(async (endpoint: InferenceEndpoint, model: string) => {
      endpoints.push(endpoint);
      models.push(model);
      return { offTopic: false, sectionIds: [] };
    }),
    refusal: jest.fn(),
  };
  const generation = {
    generate: jest.fn(async (endpoint: InferenceEndpoint, model: string) => {
      endpoints.push(endpoint);
      models.push(model);
      return { role: 'assistant', content: 'answer' };
    }),
    finalizeContent: jest.fn(async (content: string) => content),
  };
  const deps: unknown[] = new Array(39).fill({});
  deps[0] = inference;
  deps[1] = { resolveToolCalls: jest.fn() };
  deps[2] = generation;
  deps[3] = guard;
  deps[4] = {
    basePrompt: () => ({ stable: 'stable', turn: 'base' }),
    getIndexPrompt: () => 'index',
    systemPrompt: () => ({ stable: 'stable', turn: 'system' }),
    capSections: (ids: string[]) => ids,
    docLinksFor: () => [],
    selectSections: () => ({ sectionIds: [], via: 'fallback' }),
  };
  deps[5] = { resolve: () => new Set(['mcp:app:read']) };
  deps[36] = { get: () => undefined };
  deps[37] = { for: () => ({}) };
  deps[38] = { resolveAccess: async () => ({ isSandbox: true }) };
  const service = new (AssistantAgentService as unknown as new (
    ...args: unknown[]
  ) => AssistantAgentService)(...deps);
  return { service, models, endpoints };
}

const consoleInput = {
  fluiUserId: guest.userId,
  appId: 'app-1',
  dbInstallId: 'app-1',
} as never;

const anything = new Proxy({}, { get: () => async () => [] }) as Record<
  string,
  unknown
>;

function quiet<T extends object>(service: T, helpers: string[]): T {
  for (const helper of helpers) {
    jest
      .spyOn(service as unknown as Record<string, () => unknown>, helper)
      .mockImplementation(() => '' as never);
  }
  return service;
}

function copilots(inference: AssistantInferenceService, llm: unknown) {
  const knowledge = { getSystemContext: () => '' };
  const audit = { emit: () => undefined };
  return {
    'console:db': () =>
      quiet(
        new DbAssistService(
          inference,
          llm as never,
          knowledge as never,
          { introspect: async () => ({}) } as never,
          audit as never,
        ),
        ['serializeSchema'],
      ).assist(consoleInput, 'q', [], asked),
    'console:kafka': () =>
      new KafkaAssistService(
        inference,
        llm as never,
        anything as never,
        audit as never,
      ).assist(consoleInput, 'q', [], asked),
    'console:document': () =>
      quiet(
        new DocumentAssistService(
          inference,
          llm as never,
          knowledge as never,
          anything as never,
          audit as never,
        ),
        ['serializeStructure'],
      ).assist(consoleInput, 'q', [], asked),
    'console:search': () =>
      quiet(
        new SearchAssistService(
          inference,
          llm as never,
          anything as never,
          audit as never,
        ),
        ['serializeStructure', 'systemContext'],
      ).assist(consoleInput, 'q', [], asked),
    'console:search (raw)': () =>
      quiet(
        new SearchAssistService(
          inference,
          llm as never,
          anything as never,
          audit as never,
        ),
        ['serializeStructure', 'systemContextFrom'],
      ).assistRaw(consoleInput, 'q', [], asked),
    'console:fulltext': () =>
      new FulltextAssistService(
        inference,
        llm as never,
        anything as never,
        audit as never,
      ).assistSearch(consoleInput, 'q', undefined, [], asked),
    'console:fulltext (raw)': () =>
      new FulltextAssistService(
        inference,
        llm as never,
        anything as never,
        audit as never,
      ).assistRaw(consoleInput, 'q', [], asked),
    'console:kv': () =>
      quiet(
        new KvAssistService(
          inference,
          llm as never,
          knowledge as never,
          { summary: async () => ({}) } as never,
          audit as never,
        ),
        ['serializeSummary'],
      ).assist(consoleInput, 'q', [], asked),
  };
}

describe('a guest cannot use any model but the pinned one', () => {
  it('assistant agent: the router and the answer both run on the pinned model', async () => {
    const { service, models, endpoints } = agentWith(
      inferenceFor({ pinned: PINNED }),
    );
    await service.run(guest, {
      ...asked,
      messages: [{ role: 'user', content: 'How do I see my app logs?' }],
    } as AgentRequestDto);
    expect(models.length).toBeGreaterThan(1);
    expect(new Set(models)).toEqual(new Set([PINNED]));
    for (const e of endpoints) expect(e.apiKey).toBe(INSTANCE.apiKey);
  });

  it('assistant stream: same turn with an emitter, same pinned model', async () => {
    const { service, models } = agentWith(inferenceFor({ pinned: PINNED }));
    const events: unknown[] = [];
    await service.run(
      guest,
      {
        ...asked,
        messages: [{ role: 'user', content: 'How do I see my app logs?' }],
      } as AgentRequestDto,
      (e) => void events.push(e),
    );
    expect(new Set(models)).toEqual(new Set([PINNED]));
  });

  it('with nothing configured, the endpoint default wins over the request', async () => {
    const { service, models } = agentWith(inferenceFor({}));
    await service.run(guest, {
      ...asked,
      messages: [{ role: 'user', content: 'How do I see my app logs?' }],
    } as AgentRequestDto);
    expect(new Set(models)).toEqual(new Set([INSTANCE.defaultModel]));
  });

  it('with no model anywhere, the request is still ignored', async () => {
    const inference = inferenceFor({ endpointDefault: false });
    const { endpoint } = await inference.resolveEndpoint(asked, guest);
    await expect(inference.resolveModel(asked, endpoint)).resolves.toBe(
      'first-listed',
    );
  });

  it('chat/completions: closed to guests by the fence, and pinned behind it', async () => {
    expect(isSandboxAllowed('POST', '/assistant/v1/chat/completions')).toBe(
      false,
    );
    const { calls, llm } = capturingLlm();
    const guard = {
      route: async (endpoint: InferenceEndpoint, model: string) => {
        calls.push({ endpoint, model });
        return { offTopic: false, sectionIds: [] };
      },
    };
    const service = new AssistantService(
      inferenceFor({ pinned: PINNED }),
      llm as never,
      guard as never,
      {
        getIndexPrompt: () => '',
        getSystemContext: () => '',
        selectSections: () => ({ sectionIds: [], via: 'fallback' }),
      } as never,
      { record: async () => undefined } as never,
    );
    await expect(
      service.chat(guest, {
        ...asked,
        messages: [{ role: 'user', content: 'hi' }],
      } as ChatCompletionRequestDto),
    ).rejects.toThrow(CAPTURED);
    expectPinned(calls);
  });

  describe('console copilots', () => {
    const { calls, llm } = capturingLlm();
    const runs = copilots(inferenceFor({ pinned: PINNED }), llm);
    beforeEach(() => calls.splice(0));

    it.each(Object.keys(runs))('%s runs on the pinned model', async (key) => {
      await expect(runs[key as keyof typeof runs]()).rejects.toThrow(CAPTURED);
      expectPinned(calls);
      expect(calls[0].endpoint.spender?.surface).toBe(key.split(' ')[0]);
    });
  });

  it('cannot bring a model of its own: personal connections are outside the fence', () => {
    expect(isSandboxAllowed('POST', '/inference/connections/mine')).toBe(false);
    expect(isSandboxAllowed('POST', '/inference/connections')).toBe(false);
    expect(isSandboxAllowed('POST', '/inference/connections/c1/validate')).toBe(
      false,
    );
    expect(
      isSandboxAllowed('POST', '/inference/providers/scaleway/validate'),
    ).toBe(false);
  });
});
