import { AxiosError } from 'axios';
import { Readable } from 'node:stream';
import { ChatCompletionRequest } from '../interfaces/chat-completion';
import {
  applyParamAdaptation,
  detectParamAdaptation,
  normalizeAxiosErrorBody,
} from './param-recovery.util';

function axios400(body: unknown, asStream = false): AxiosError {
  const err = new AxiosError('bad request', 'ERR_BAD_REQUEST');
  err.response = {
    status: 400,
    statusText: 'Bad Request',
    data: asStream ? Readable.from([JSON.stringify(body)]) : body,
    headers: {},
    config: {} as never,
  } as never;
  return err;
}

const req = (over: Partial<ChatCompletionRequest>): ChatCompletionRequest => ({
  model: 'some-model',
  messages: [{ role: 'user', content: 'hi' }],
  temperature: 0.2,
  max_tokens: 256,
  ...over,
});

describe('detectParamAdaptation', () => {
  it('detects a rename when the error names the replacement', () => {
    const error = axios400({
      param: 'max_tokens',
      code: 'unsupported_parameter',
      message:
        "Unsupported parameter: 'max_tokens' is not supported. Use 'max_completion_tokens' instead.",
    });
    expect(detectParamAdaptation(req({}), error)).toEqual({
      param: 'max_tokens',
      replacement: 'max_completion_tokens',
    });
  });

  it('detects a drop when no replacement is offered', () => {
    const error = axios400({
      param: 'temperature',
      message:
        "'temperature' does not support 0.2. Only the default is supported.",
    });
    expect(detectParamAdaptation(req({}), error)).toEqual({
      param: 'temperature',
      replacement: undefined,
    });
  });

  it('reads the OpenAI { error: {...} } envelope shape too', () => {
    const error = axios400({
      error: { param: 'temperature', message: 'not supported' },
    });
    expect(detectParamAdaptation(req({}), error)?.param).toBe('temperature');
  });

  it('returns null for a param we never sent (avoids a pointless retry)', () => {
    const error = axios400({ param: 'top_p', message: 'nope' });
    expect(detectParamAdaptation(req({}), error)).toBeNull();
  });

  it('refuses essential fields and non-adaptable params', () => {
    for (const param of ['model', 'messages', 'tools']) {
      expect(detectParamAdaptation(req({}), axios400({ param }))).toBeNull();
    }
  });

  it('returns null for non-400 or bodies without a param', () => {
    expect(
      detectParamAdaptation(req({}), axios400({ message: 'generic' })),
    ).toBeNull();
    expect(detectParamAdaptation(req({}), new Error('boom'))).toBeNull();
  });
});

describe('applyParamAdaptation', () => {
  it('renames a param to its replacement without mutating the input', () => {
    const input = req({});
    const out = applyParamAdaptation(input, {
      param: 'max_tokens',
      replacement: 'max_completion_tokens',
    });
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBe(256);
    expect(input.max_tokens).toBe(256); // untouched
  });

  it('drops a param when there is no replacement', () => {
    const out = applyParamAdaptation(req({}), { param: 'temperature' });
    expect(out.temperature).toBeUndefined();
  });

  it('is a no-op when the param is absent (safe for cached adaptations)', () => {
    const input = req({ max_tokens: undefined });
    expect(
      applyParamAdaptation(input, {
        param: 'max_tokens',
        replacement: 'max_completion_tokens',
      }),
    ).toBe(input);
  });
});

describe('normalizeAxiosErrorBody', () => {
  it('buffers a streamed error body so the param contract becomes readable', async () => {
    const error = axios400(
      { param: 'max_tokens', message: "Use 'max_completion_tokens' instead." },
      true,
    );
    expect(detectParamAdaptation(req({}), error)).toBeNull(); // still a stream
    await normalizeAxiosErrorBody(error);
    expect(detectParamAdaptation(req({}), error)?.replacement).toBe(
      'max_completion_tokens',
    );
  });

  it('is a no-op for an already-parsed body', async () => {
    const error = axios400({ param: 'temperature', message: 'x' });
    await normalizeAxiosErrorBody(error);
    expect(detectParamAdaptation(req({}), error)?.param).toBe('temperature');
  });
});
