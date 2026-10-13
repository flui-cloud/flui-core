import { PerKeyLimit } from '../../common/throttling/per-key-limit';

export const MCP_THROTTLER = 'MCP_THROTTLER';
export const MCP_LIMIT_CODE = 'MCP_RATE_LIMIT';

/**
 * Per person, not per address: an agent on the same machine as the API comes
 * from the loopback address, and every agent of one person counts together.
 */
export function mcpRequestLimit(
  env: NodeJS.ProcessEnv = process.env,
): PerKeyLimit {
  const parsed = Number(env.MCP_REQUESTS_PER_MINUTE);
  return {
    name: 'mcp',
    ttlMs: 60_000,
    limit: Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 60,
    code: MCP_LIMIT_CODE,
    message: 'Too many agent requests. Wait a minute and try again.',
  };
}

const isExempt = (message: unknown): boolean => {
  const method = (message as { method?: unknown } | null)?.method;
  return (
    typeof method === 'string' &&
    (method === 'ping' || method.startsWith('notifications/'))
  );
};

/** Keep-alives and notifications cost nothing to serve, so only real calls count. */
export function countsTowardMcpLimit(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.length === 0 || !messages.every(isExempt);
}
