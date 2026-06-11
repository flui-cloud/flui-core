import { HttpException, HttpStatus } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { describeError } from '../../shared/utils/error.util';

export type InferenceErrorCode =
  | 'rate_limit'
  | 'auth'
  | 'timeout'
  | 'upstream'
  | 'unavailable';

interface InferenceErrorResponse {
  message: string;
  error: 'InferenceError';
  code: InferenceErrorCode;
  retryAfter?: number;
}

/**
 * An upstream inference failure mapped to a clean, user-readable message and the right HTTP
 * status. Carries `code`/`retryAfter` so the chat UI can render a tidy banner (e.g. a
 * rate-limit countdown) instead of the raw provider body.
 */
export class InferenceProviderException extends HttpException {
  readonly code: InferenceErrorCode;
  readonly retryAfter?: number;

  constructor(response: InferenceErrorResponse, status: HttpStatus) {
    super(response, status);
    this.code = response.code;
    this.retryAfter = response.retryAfter;
  }
}

/** Retry-After is either delta-seconds or an HTTP date; normalise both to seconds-from-now. */
function parseRetryAfter(error: AxiosError): number | undefined {
  const raw = error.response?.headers?.['retry-after'];
  if (typeof raw !== 'string' || !raw.length) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const when = Date.parse(raw);
  if (!Number.isNaN(when))
    return Math.max(0, Math.round((when - Date.now()) / 1000));
  return undefined;
}

export function toInferenceError(error: unknown): InferenceProviderException {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;

    if (status === 429) {
      const retryAfter = parseRetryAfter(error);
      const wait =
        retryAfter === undefined
          ? ' Please wait a moment and try again.'
          : ` Try again in about ${retryAfter}s.`;
      return new InferenceProviderException(
        {
          message: `The AI provider's rate limit was reached.${wait}`,
          error: 'InferenceError',
          code: 'rate_limit',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (status === 401 || status === 403) {
      return new InferenceProviderException(
        {
          message:
            'The AI provider rejected the inference credential. Check the connection’s API key.',
          error: 'InferenceError',
          code: 'auth',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new InferenceProviderException(
        {
          message:
            'The AI provider took too long to respond. Please try again.',
          error: 'InferenceError',
          code: 'timeout',
        },
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }

    if (error.response?.status !== undefined) {
      // Any other status the provider returned (bad model, rejected tool schema,
      // unsupported parameter) is a real, actionable error — surface it verbatim
      // instead of an opaque "temporarily unavailable".
      return new InferenceProviderException(
        {
          message: describeError(error, 'Inference request failed'),
          error: 'InferenceError',
          code: 'upstream',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  return new InferenceProviderException(
    {
      message: 'The AI provider is temporarily unavailable. Please try again.',
      error: 'InferenceError',
      code: 'unavailable',
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
