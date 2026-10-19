jest.mock('../../applications/services/application.service', () => ({
  ApplicationService: class {},
}));
jest.mock('../../catalog/services/catalog-installer.service', () => ({
  CatalogInstallerService: class {},
}));

import {
  AssistantGenerationService,
  fitSystemMessages,
  rewriteTokenBudget,
} from './assistant-generation.service';
import { ChatCompletionMessage } from '../interfaces/chat-completion';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';

describe('AssistantGenerationService.finalizeContent', () => {
  const endpoint = { baseUrl: 'http://llm' } as unknown as InferenceEndpoint;
  const lean: ChatCompletionMessage = { role: 'system', content: 'lean' };

  function build(rewrite: string | null) {
    const llm = {
      chat: jest.fn(async () => ({
        choices: [
          {
            message:
              rewrite === null ? null : { role: 'assistant', content: rewrite },
          },
        ],
      })),
      chatStream: jest.fn(),
    };
    const apps = { filterKnownEndpointHosts: jest.fn(async () => []) };
    const installer = { existingResolvedFqdns: jest.fn(async () => []) };
    const service = new AssistantGenerationService(
      llm as never,
      apps as never,
      installer as never,
    );
    return { service, llm };
  }

  function run(service: AssistantGenerationService, content: string) {
    const conversation: ChatCompletionMessage[] = [
      { role: 'user', content: 'question' },
      { role: 'assistant', content },
    ];
    return service
      .finalizeContent(content, conversation, [], endpoint, 'm', {} as never, [
        lean,
      ])
      .then((out) => ({ out, conversation }));
  }

  it('does not regenerate for documentation, example and template URLs', async () => {
    const { service, llm } = build('unused');
    const content = [
      'Read [Deploy](https://docs.flui.cloud/tasks/deploy-from-repository).',
      'Source: https://github.com/flui-cloud/flui-core',
      '```yaml\ndomain: https://app.example.com\n```',
      'Then open https://app.<your-domain>.',
    ].join('\n');
    const { out } = await run(service, content);
    expect(out).toBe(content);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('accepts hosts named by the knowledge the turn was grounded in', async () => {
    const { service, llm } = build('unused');
    const content =
      'Use base URL https://api.mistral.ai/v1 for the connection.';
    const conversation: ChatCompletionMessage[] = [
      { role: 'user', content: 'question' },
      { role: 'assistant', content },
    ];
    const grounding: ChatCompletionMessage = {
      role: 'system',
      content: 'Knowledge: Mistral lives at https://api.mistral.ai/v1.',
    };
    const out = await service.finalizeContent(
      content,
      conversation,
      [],
      endpoint,
      'm',
      {} as never,
      [lean],
      [grounding],
    );
    expect(out).toBe(content);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('regenerates once with a bounded budget naming the offending URL', async () => {
    const { service, llm } = build(
      'Your app is ready; its address is on the application page.',
    );
    const content = 'Your app is ready at https://shop-1a2b.flui.app now.';
    const { out, conversation } = await run(service, content);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    const request = (llm.chat.mock.calls[0] as unknown[])[1] as {
      max_tokens: number;
      messages: ChatCompletionMessage[];
    };
    expect(request.max_tokens).toBeLessThanOrEqual(2048);
    expect(String(request.messages.at(-1)?.content)).toContain(
      'https://shop-1a2b.flui.app',
    );
    expect(out).toBe(
      'Your app is ready; its address is on the application page.',
    );
    expect(conversation[1].content).toBe(out);
  });

  it('keeps the draft and strips only the URL when the rewrite lost the answer', async () => {
    const { service } = build('Sorry, I cannot help.');
    const content =
      'Flui has a control cluster and workload clusters. The control cluster runs the API and the dashboard; workload clusters run your apps. See https://made-up.acme.io/clusters for more.';
    const { out } = await run(service, content);
    expect(out).toBe(
      content.replace('https://made-up.acme.io/clusters', '`<app-url>`'),
    );
  });

  it('strips what still slips through the rewrite', async () => {
    const { service } = build(
      'Open https://shop-1a2b.flui.app to use the shop now.',
    );
    const { out } = await run(
      service,
      'Open https://shop-1a2b.flui.app to use it.',
    );
    expect(out).toBe('Open `<app-url>` to use the shop now.');
  });

  it('falls back to the stripped draft when the rewrite call fails', async () => {
    const { service, llm } = build('x');
    llm.chat.mockRejectedValueOnce(new Error('429'));
    const { out } = await run(
      service,
      'Go to https://shop-1a2b.flui.app please.',
    );
    expect(out).toBe('Go to `<app-url>` please.');
  });
});

describe('fitSystemMessages', () => {
  const split: ChatCompletionMessage[] = [
    { role: 'system', content: 'stable' },
    { role: 'system', content: 'turn' },
    { role: 'user', content: 'q' },
  ];

  it('keeps the fixed system message apart for a provider verified to take several', () => {
    const endpoint = {
      acceptsSeveralSystemMessages: true,
    } as unknown as InferenceEndpoint;
    expect(fitSystemMessages(endpoint, split)).toBe(split);
  });

  it('joins them into the single message other providers got before', () => {
    const endpoint = { baseUrl: 'http://byo' } as unknown as InferenceEndpoint;
    expect(fitSystemMessages(endpoint, split)).toEqual([
      { role: 'system', content: 'stable\n\nturn' },
      { role: 'user', content: 'q' },
    ]);
  });
});

describe('rewriteTokenBudget', () => {
  it('stays between the floor and the ceiling and under the caller cap', () => {
    expect(rewriteTokenBudget('short', undefined)).toBe(256);
    expect(rewriteTokenBudget('x'.repeat(30000), undefined)).toBe(2048);
    expect(rewriteTokenBudget('x'.repeat(3000), 512)).toBe(512);
  });
});
