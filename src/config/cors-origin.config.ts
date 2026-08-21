/**
 * Which browser origins this instance answers.
 *
 * Shared by the HTTP layer and every websocket gateway, because the two used to
 * disagree: HTTP reflected the caller's origin while the gateways declared
 * `origin: '*'` alongside `credentials: true` — a pair no browser accepts, so a
 * credentialed handshake was refused before it reached the token check. That was
 * invisible while every client held a bearer token, and total for a sandbox
 * guest, whose only credential is a cookie the page cannot read.
 *
 * Reflecting a checked origin is also narrower than the wildcard it replaces.
 */
import { stripTrailingSlashes } from '../common/utils/url.util';

export type CorsOriginCallback = (
  err: Error | null,
  allow?: boolean | string,
) => void;

const isIpHost = (host: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

function apexOf(url: string | undefined): string {
  try {
    const { hostname } = new URL(url || '');
    if (isIpHost(hostname)) return '';
    const parts = hostname.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : '';
  } catch {
    return '';
  }
}

export function isAllowedOrigin(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const frontendUrl = stripTrailingSlashes(
    env.FRONTEND_URL || env.DASHBOARD_URL || '',
  );
  const extraOrigins = new Set(
    (env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => stripTrailingSlashes(s.trim()))
      .filter(Boolean),
  );
  const apexDomain = apexOf(env.API_BASE_URL);

  return Boolean(
    (frontendUrl && origin === frontendUrl) ||
      extraOrigins.has(origin) ||
      (apexDomain &&
        (origin === `https://${apexDomain}` ||
          origin.endsWith(`.${apexDomain}`))) ||
      (env.NODE_ENV !== 'production' &&
        /^https?:\/\/localhost(:\d+)?$/.test(origin)),
  );
}

/** A same-origin or non-browser caller sends no Origin; it is not a CORS case. */
export function corsOriginDelegate(
  origin: string | undefined,
  callback: CorsOriginCallback,
): void {
  if (!origin) return callback(null, true);
  callback(null, isAllowedOrigin(origin) ? origin : false);
}

/** The `cors` block every websocket gateway declares. */
export const WS_CORS = {
  origin: corsOriginDelegate,
  credentials: true,
};
