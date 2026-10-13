import { VisitorConfig } from './visitor.config';

const MAX_RETURN_LENGTH = 512;
const OWN_PARAMS = ['visitor', 'flow', 'reason'];
const PROBE_ORIGIN = 'http://return.invalid';

/**
 * A place in the dashboard to come back to: a path of its own, never an
 * address. Anything else is dropped rather than corrected.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_RETURN_LENGTH) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\') || /[\u0000-\u001f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;
  for (const param of OWN_PARAMS) url.searchParams.delete(param);
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path.length > MAX_RETURN_LENGTH ? null : path;
}

/** The dashboard's own address for a path, with the visitor's outcome added. */
export function dashboardUrl(
  config: Pick<VisitorConfig, 'dashboardOrigin'>,
  path: string | null,
  params: Record<string, string>,
): string {
  const url = new URL(safeReturnPath(path) ?? '/', config.dashboardOrigin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
