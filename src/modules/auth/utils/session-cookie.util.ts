import { Response } from 'express';
import { FLUI_SESSION_COOKIE } from './cookie-extractor.util';

interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  domain?: string;
  maxAge?: number;
}

function decodeJwtExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    ) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function resolveCookieDomain(): string | undefined {
  const explicit = process.env.FLUI_COOKIE_DOMAIN?.trim();
  if (explicit) return explicit;
  try {
    const { hostname } = new URL(process.env.API_BASE_URL || '');
    const parts = hostname.split('.');
    if (parts.length >= 2) return '.' + parts.slice(-2).join('.');
  } catch {
    /* no-op */
  }
  return undefined;
}

function buildBaseCookieOptions(): CookieOptions {
  const domain = resolveCookieDomain();
  const secure =
    process.env.NODE_ENV === 'production' ||
    process.env.FLUI_COOKIE_SECURE === 'true';
  const sameSite =
    (process.env.FLUI_COOKIE_SAMESITE as
      | 'lax'
      | 'strict'
      | 'none'
      | undefined) || 'lax';
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    ...(domain ? { domain } : {}),
  };
}

/**
 * Mirrors the access token into the `flui_session` cookie so the dashboard
 * can reach internal apps on a wildcard sub-domain via ForwardAuth: the
 * browser sends the cookie automatically cross-sub-domain while the
 * `Authorization` header is not available from iframes / cross-origin page
 * loads.
 */
export function setFluiSessionCookie(
  res: Response,
  accessToken: string,
  expiresAt?: Date,
): void {
  const base = buildBaseCookieOptions();
  const nowSec = Math.floor(Date.now() / 1000);
  /**
   * `expiresAt` is for credentials that carry their expiry out of band. An API
   * key is not a JWT, so decoding it yields nothing and the hour-long fallback
   * takes over — which would sign a sandbox guest out sixty minutes into a
   * twenty-four hour tenancy, with the countdown still promising a day.
   */
  const expSec = expiresAt
    ? Math.floor(expiresAt.getTime() / 1000)
    : decodeJwtExp(accessToken);
  const ttlSec = expSec && expSec > nowSec ? expSec - nowSec : 3600;
  res.cookie(FLUI_SESSION_COOKIE, accessToken, {
    ...base,
    maxAge: ttlSec * 1000,
  });
}

export function clearFluiSessionCookie(res: Response): void {
  const base = buildBaseCookieOptions();
  res.clearCookie(FLUI_SESSION_COOKIE, {
    httpOnly: base.httpOnly,
    secure: base.secure,
    sameSite: base.sameSite,
    path: base.path,
    ...(base.domain ? { domain: base.domain } : {}),
  });
}
