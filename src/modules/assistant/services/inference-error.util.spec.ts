import { HttpStatus } from '@nestjs/common';
import { AxiosError } from 'axios';
import {
  InferenceProviderException,
  toInferenceError,
} from './inference-error.util';

function axiosError(opts: {
  status?: number;
  headers?: Record<string, string>;
  code?: string;
}): AxiosError {
  const err = new AxiosError('upstream boom', opts.code);
  if (opts.status !== undefined) {
    err.response = {
      status: opts.status,
      statusText: '',
      data: { message: 'raw provider body' },
      headers: opts.headers ?? {},
      config: {} as never,
    } as never;
  }
  return err;
}

describe('toInferenceError', () => {
  it('maps 429 with numeric Retry-After to a rate_limit with seconds', () => {
    const ex = toInferenceError(
      axiosError({ status: 429, headers: { 'retry-after': '30' } }),
    );
    expect(ex).toBeInstanceOf(InferenceProviderException);
    expect(ex.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(ex.code).toBe('rate_limit');
    expect(ex.retryAfter).toBe(30);
    expect(ex.message).toContain('30s');
  });

  it('maps 429 without Retry-After to rate_limit with no countdown', () => {
    const ex = toInferenceError(axiosError({ status: 429 }));
    expect(ex.code).toBe('rate_limit');
    expect(ex.retryAfter).toBeUndefined();
    expect(ex.message).toContain('wait a moment');
  });

  it('maps 401/403 to an auth error (502)', () => {
    for (const status of [401, 403]) {
      const ex = toInferenceError(axiosError({ status }));
      expect(ex.code).toBe('auth');
      expect(ex.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    }
  });

  it('maps a timeout to a timeout error (504)', () => {
    const ex = toInferenceError(axiosError({ code: 'ECONNABORTED' }));
    expect(ex.code).toBe('timeout');
    expect(ex.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
  });

  it('surfaces any other upstream status verbatim (502, diagnosable)', () => {
    const ex = toInferenceError(axiosError({ status: 400 }));
    expect(ex.code).toBe('upstream');
    expect(ex.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    // The real provider body must reach the message so misconfig is diagnosable.
    expect(ex.message).toContain('raw provider body');
    expect(ex.message).toContain('[400]');
  });

  it('maps a network error (no response) to unavailable (503)', () => {
    const ex = toInferenceError(new Error('nope'));
    expect(ex.code).toBe('unavailable');
    expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('keeps the rate-limit message clean (no raw provider body)', () => {
    const ex = toInferenceError(axiosError({ status: 429 }));
    expect(ex.message).not.toContain('raw provider body');
  });
});
