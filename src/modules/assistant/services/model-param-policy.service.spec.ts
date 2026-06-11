import { ChatCompletionRequest } from '../interfaces/chat-completion';
import { ModelParamPolicyService } from './model-param-policy.service';

const OPENAI = 'https://api.openai.com/v1';
const req = (
  over: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest => ({
  model: 'o3-mini',
  messages: [{ role: 'user', content: 'hi' }],
  temperature: 0.2,
  max_tokens: 256,
  ...over,
});

describe('ModelParamPolicyService', () => {
  it('is a no-op until something is learned', () => {
    const svc = new ModelParamPolicyService();
    expect(svc.apply(OPENAI, req())).toEqual(req());
  });

  it('applies a learned rename + drop to later requests', () => {
    const svc = new ModelParamPolicyService();
    svc.learn(OPENAI, 'o3-mini', {
      param: 'max_tokens',
      replacement: 'max_completion_tokens',
    });
    svc.learn(OPENAI, 'o3-mini', { param: 'temperature' });

    const out = svc.apply(OPENAI, req());
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBe(256);
    expect(out.temperature).toBeUndefined();
  });

  it('scopes policy by host and model', () => {
    const svc = new ModelParamPolicyService();
    svc.learn(OPENAI, 'o3-mini', { param: 'temperature' });

    // different model on same host — untouched
    expect(svc.apply(OPENAI, req({ model: 'gpt-4o' })).temperature).toBe(0.2);
    // different host — untouched
    expect(svc.apply('https://api.mistral.ai/v1', req()).temperature).toBe(0.2);
  });

  it('re-learning the same param overwrites (no unbounded growth/conflict)', () => {
    const svc = new ModelParamPolicyService();
    svc.learn(OPENAI, 'o3-mini', {
      param: 'max_tokens',
      replacement: 'max_completion_tokens',
    });
    svc.learn(OPENAI, 'o3-mini', { param: 'max_tokens' }); // now a drop

    const out = svc.apply(OPENAI, req());
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBeUndefined();
  });

  it('does not mutate the input request', () => {
    const svc = new ModelParamPolicyService();
    svc.learn(OPENAI, 'o3-mini', { param: 'temperature' });
    const input = req();
    svc.apply(OPENAI, input);
    expect(input.temperature).toBe(0.2);
  });
});
