import axios from 'axios';
import { ChatCompletionRequest } from '../interfaces/chat-completion';

// Tuning params we may safely rename or drop in response to a provider's rejection.
// Essential fields (model, messages, tools) are never touched.
const ADAPTABLE = new Set<string>([
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'tool_choice',
  'frequency_penalty',
  'presence_penalty',
]);

// OpenAI-style 400s often name the replacement param, e.g.
// "Unsupported parameter: 'max_tokens' ... Use 'max_completion_tokens' instead."
const RENAME_HINT = /use\s+'([a-z_]+)'\s+instead/i;

interface ParamRejection {
  param: string;
  message?: string;
}

/** A learned fix for one rejected param: rename it to `replacement`, or drop it (no replacement). */
export interface ParamAdaptation {
  param: string;
  replacement?: string;
}

/**
 * With `responseType: 'stream'`, axios leaves an error body as an unread stream. Buffer it
 * back into `response.data` so the standard error contract (`param`, `message`) is readable
 * for both recovery and diagnostics — a no-op when the body is already parsed.
 */
export async function normalizeAxiosErrorBody(error: unknown): Promise<void> {
  if (!axios.isAxiosError(error)) return;
  const data = error.response?.data as { pipe?: unknown } | undefined;
  if (!data || typeof data.pipe !== 'function') return;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of data as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    return;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // leave as raw text
  }
  (error.response as { data: unknown }).data = parsed;
}

function paramRejection(error: unknown): ParamRejection | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 400) return null;
  const data = error.response?.data;
  if (!data || typeof data !== 'object') return null;
  const body = data as Record<string, unknown>;
  const node = (
    body.error && typeof body.error === 'object' ? body.error : body
  ) as Record<string, unknown>;
  if (typeof node.param !== 'string') return null;
  return {
    param: node.param,
    message: typeof node.message === 'string' ? node.message : undefined,
  };
}

/**
 * Reads a provider's "unsupported parameter" 400 and derives the fix by reacting to the
 * standard error contract — no per-provider branching. If the message names a replacement
 * param it's a rename (e.g. max_tokens → max_completion_tokens); otherwise the param is
 * dropped (e.g. a reasoning model that only allows the default temperature). Returns null
 * when the error names nothing safe to change or a param we didn't send (avoids a pointless
 * retry). The returned adaptation can be applied now AND cached for future requests.
 */
export function detectParamAdaptation(
  request: ChatCompletionRequest,
  error: unknown,
): ParamAdaptation | null {
  const rejection = paramRejection(error);
  if (!rejection || !ADAPTABLE.has(rejection.param)) return null;

  const current = request as unknown as Record<string, unknown>;
  if (current[rejection.param] === undefined) return null;

  const replacement = rejection.message
    ? RENAME_HINT.exec(rejection.message)?.[1]
    : undefined;
  return {
    param: rejection.param,
    replacement:
      replacement && replacement !== rejection.param ? replacement : undefined,
  };
}

/**
 * Applies one adaptation to a request, returning a new object (the input is never mutated).
 * A no-op when the param isn't present, so it's safe to apply cached adaptations blindly.
 */
export function applyParamAdaptation(
  request: ChatCompletionRequest,
  adaptation: ParamAdaptation,
): ChatCompletionRequest {
  const current = request as unknown as Record<string, unknown>;
  if (current[adaptation.param] === undefined) return request;

  const next: Record<string, unknown> = { ...current };
  if (adaptation.replacement) {
    next[adaptation.replacement] = current[adaptation.param];
  }
  delete next[adaptation.param];
  return next as unknown as ChatCompletionRequest;
}
