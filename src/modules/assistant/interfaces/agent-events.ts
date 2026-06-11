import { AgentResult, AgentToolStep } from './agent';
import { InferenceErrorCode } from '../services/inference-error.util';

/**
 * Server-Sent Event frames for a streamed agent turn. `delta` carries text tokens
 * as the model emits them; `step` fires when a tool finishes (live tools-used);
 * `done` is the single terminal frame carrying the canonical AgentResult (message
 * OR pending_action) the client persists and resumes from; `error` ends on failure.
 * On a provider failure `code` classifies it (e.g. `rate_limit`) and `retryAfter`
 * carries the seconds to wait, so the UI can show a tidy banner instead of raw text.
 */
export type AgentStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'step'; step: AgentToolStep }
  | { type: 'done'; result: AgentResult }
  | {
      type: 'error';
      message: string;
      code?: InferenceErrorCode;
      retryAfter?: number;
    };

export type AgentEmitter = (event: AgentStreamEvent) => void;
