import { Request } from 'express';

export const FLUI_SESSION_COOKIE = 'flui_session';

/**
 * Reads the Flui session JWT from the `Cookie` header of a request to the
 * API's own host. Used by passport-jwt strategies so the cookie session (the
 * sandbox, the dashboard's cookie calls) is accepted like a Bearer token.
 *
 * Manual parse keeps us off a `cookie-parser` middleware dependency —
 * single-header parse is simpler than setting up an Express middleware
 * globally just for one cookie.
 */
export function extractJwtFromFluiSessionCookie(req: Request): string | null {
  const header = req?.headers?.cookie;
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${FLUI_SESSION_COOKIE}=`)) continue;
    const raw = trimmed.slice(FLUI_SESSION_COOKIE.length + 1);
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}
