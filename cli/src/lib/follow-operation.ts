import { ApiClient } from './api-client';

export interface FollowedOperation<M = Record<string, unknown>> {
  id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  progress?: number;
  errorMessage?: string | null;
  metadata?: M | null;
}

const DONE = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * Polls an operation until it ends. Transient read errors are retried: the
 * operation keeps running whether or not this terminal is watching it.
 */
export async function followOperation<M = Record<string, unknown>>(
  api: ApiClient,
  operationId: string,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    onUpdate?: (op: FollowedOperation<M>) => void;
  } = {},
): Promise<FollowedOperation<M> | null> {
  const interval = opts.intervalMs ?? 5000;
  const deadline = Date.now() + (opts.timeoutMs ?? 24 * 60 * 60 * 1000);
  while (Date.now() < deadline) {
    try {
      const op = await api.get<FollowedOperation<M>>(
        `/infrastructure/operations/${operationId}`,
      );
      opts.onUpdate?.(op);
      if (DONE.has(op.status)) return op;
    } catch {
      // Keep following.
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}
