import { loginUrl } from '../sandbox-entry';
import { stripTrailingSlashes } from '../../../common/utils/url.util';

export const VISITOR_CONFIG = 'SANDBOX_VISITOR_CONFIG';

export const VISITOR_WEB_APP_NAME = 'flui-try-web';
export const VISITOR_CLI_APP_NAME = 'flui-try-cli';
export const VISITOR_LOGIN_CLIENT_USERNAME = 'flui-visitor-login';
export const VISITOR_LOGIN_PATH = '/api/v1/sandbox/visitor';
export const VISITOR_CLIENT_ENV = 'OIDC_VISITOR_CLIENT_ID';
export const VISITOR_CLI_CLIENT_ENV = 'OIDC_VISITOR_CLI_CLIENT_ID';

export interface VisitorConfig {
  /** The sandbox and the visitors' entrance are both on: the kill switch. */
  enabled: boolean;
  /** The demo itself is on: visitors already inside are still swept when the entrance is shut. */
  sandboxEnabled: boolean;
  poolMin: number;
  perIpHour: number;
  /** The CLI skips the browser check, so it gets a smaller allowance per address. */
  cliPerIpHour: number;
  globalPerMinute: number;
  /** Every visitor leaves events at the identity provider that are never pruned. */
  globalPerDay: number;
  idleMs: number;
  maxMs: number;
  maxHours: number;
  turnstileSecret: string | null;
  turnstileSiteKey: string | null;
  ipHashKey: string | null;
  dashboardOrigin: string;
  apiBase: string;
}

const HOUR_MS = 3_600_000;

const positive = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const text = (raw: string | undefined): string | null => {
  const value = (raw ?? '').trim();
  return value ? value : null;
};

export function loadVisitorConfig(
  env: NodeJS.ProcessEnv = process.env,
): VisitorConfig {
  const maxHours = positive(env.SANDBOX_VISITOR_MAX_HOURS, 168);
  return {
    enabled:
      env.SANDBOX_ENABLED === 'true' && env.SANDBOX_VISITORS_ENABLED === 'true',
    sandboxEnabled: env.SANDBOX_ENABLED === 'true',
    poolMin: positive(env.SANDBOX_VISITOR_POOL_MIN, 3),
    perIpHour: positive(env.SANDBOX_VISITORS_PER_IP_HOUR, 10),
    cliPerIpHour: positive(env.SANDBOX_VISITORS_CLI_PER_IP_HOUR, 3),
    globalPerMinute: positive(env.SANDBOX_VISITORS_GLOBAL_PER_MINUTE, 30),
    globalPerDay: positive(env.SANDBOX_VISITORS_GLOBAL_PER_DAY, 2000),
    idleMs: positive(env.SANDBOX_VISITOR_IDLE_HOURS, 48) * HOUR_MS,
    maxMs: maxHours * HOUR_MS,
    maxHours,
    turnstileSecret: text(env.TURNSTILE_SECRET_KEY),
    turnstileSiteKey: text(env.TURNSTILE_SITE_KEY),
    ipHashKey: text(env.SANDBOX_IP_HASH_KEY),
    dashboardOrigin: loginUrl(env.SANDBOX_BASE_DOMAIN ?? 'try.flui.cloud'),
    apiBase: publicApiBase(env),
  };
}

/** Where this API is reached from a browser, without the `/api/v1` suffix. */
export function publicApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const configured = ['PUBLIC_API_URL', 'FLUI_API_ENDPOINT', 'API_BASE_URL']
    .map((key) => env[key]?.trim())
    .find((value) => !!value);
  const base = stripTrailingSlashes(
    configured || `http://localhost:${env.PORT ?? '3000'}`,
  );
  return base.endsWith('/api/v1') ? base.slice(0, -'/api/v1'.length) : base;
}

/** When a visitor made at `createdAt` stops existing, whatever it does. */
export function visitorExpiry(createdAt: Date, config: VisitorConfig): Date {
  return new Date(createdAt.getTime() + config.maxMs);
}

/** Where a refused visitor lands: the dashboard's own sign-in page, never a URL from the request. */
export function refusalUrl(config: VisitorConfig, reason: string): string {
  const params = new URLSearchParams({ visitor: 'refused', reason });
  return `${config.dashboardOrigin}/login?${params.toString()}`;
}

/** Whether a token was issued to one of the two "try" applications. */
export function isTryClient(
  clientId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!clientId) return false;
  return [VISITOR_CLIENT_ENV, VISITOR_CLI_CLIENT_ENV].some(
    (key) => text(env[key]) === clientId,
  );
}

export interface VisitorAuthConfig {
  visitorClientId?: string;
  visitorCliClientId?: string;
  turnstileSiteKey?: string;
}

/** What `/auth/config` adds for the visitors' entrance: nothing while it is shut. */
export function visitorAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): VisitorAuthConfig {
  const config = loadVisitorConfig(env);
  if (!config.enabled) return {};
  const out: VisitorAuthConfig = {};
  const web = text(env[VISITOR_CLIENT_ENV]);
  const cli = text(env[VISITOR_CLI_CLIENT_ENV]);
  if (web) out.visitorClientId = web;
  if (cli) out.visitorCliClientId = cli;
  if (config.turnstileSiteKey) out.turnstileSiteKey = config.turnstileSiteKey;
  return out;
}
