import { createHash } from 'node:crypto';

export const CONSOLE_PATH_PREFIX = '/ui/console';
export const CONSOLE_GATE_NAME = 'identity-console-gate';
export const CONSOLE_GATE_WEB_NAME = `${CONSOLE_GATE_NAME}-web`;
export const CONSOLE_GATE_REFUSE_NAME = `${CONSOLE_GATE_NAME}-refuse`;
export const CONSOLE_GATE_HASH_ANNOTATION = 'flui.cloud/gate-hash';
export const CONSOLE_GATE_PRIORITY = 1_000_000;
export const IDENTITY_PROVIDER_ROUTE_NAME = 'zitadel';
export const IDENTITY_PROVIDER_SERVICE = { name: 'zitadel', port: 8080 };
// A source no client can have: every request is refused with 403.
export const CONSOLE_GATE_SOURCE_RANGE = ['255.255.255.255/32'];
// The router already matched the decoded path; the raw URL can be encoded differently.
export const CONSOLE_GATE_REDIRECT_REGEX = '^.*$';

export const CONSOLE_WINDOW_MINUTES = { default: 60, min: 5, max: 240 };

const TRAEFIK = 'traefik.io/v1alpha1';
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A reason the refusal cannot be built that is safe to show as it is. */
export class ConsoleGateTargetError extends Error {}

export function gateFailureCause(err: unknown): string {
  if (err instanceof ConsoleGateTargetError) return err.message;
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  const status = typeof e?.code === 'number' ? e.code : e?.statusCode;
  if (typeof status === 'number') {
    return `The cluster refused the change (HTTP ${status})`;
  }
  return 'The cluster could not be reached';
}

export interface ConsoleGateTarget {
  namespace: string;
  hosts: string[];
  service: { name: string; port: number };
  /** Where a refused visitor is sent; null answers 403 instead. */
  redirectTo: string | null;
}

export interface ConsoleWindow {
  openUntil: Date | null;
}

export function isConsoleOpen(window: ConsoleWindow, now: Date): boolean {
  return !!window.openUntil && window.openUntil.getTime() > now.getTime();
}

export function isWindowExpired(window: ConsoleWindow, now: Date): boolean {
  return !!window.openUntil && window.openUntil.getTime() <= now.getTime();
}

export function hostsInRouteMatch(match: string | undefined): string[] {
  if (!match) return [];
  const hosts: string[] = [];
  for (const call of match.matchAll(/\bHost\(([^)]*)\)/g)) {
    for (const quoted of call[1].matchAll(/`([^`]+)`/g)) hosts.push(quoted[1]);
  }
  return hosts;
}

export function hostOfUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  return (
    url
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/[/:].*$/, '') || null
  );
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+)$/;

/** The dashboard address a refused visitor can be sent to, or null when none usable is known. */
export function dashboardRedirectTarget(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (!HOSTNAME.test(host) || LOOPBACK.test(host)) return null;
  if (parsed.username || parsed.password) return null;
  return `${parsed.protocol}//${parsed.host}/`;
}

/** Every public name the identity provider answers on, lower-cased, valid and once each. */
export function identityProviderHosts(sources: {
  routeMatches?: Array<string | undefined>;
  endpointHosts?: Array<string | null | undefined>;
  issuer?: string | null;
}): string[] {
  const all = [
    ...(sources.routeMatches ?? []).flatMap(hostsInRouteMatch),
    ...(sources.endpointHosts ?? []),
    hostOfUrl(sources.issuer),
  ];
  const valid = all
    .filter((h): h is string => typeof h === 'string')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => HOSTNAME.test(h));
  return [...new Set(valid)].sort((a, b) => a.localeCompare(b));
}

export function consoleGateMatch(hosts: string[]): string {
  const byHost = hosts.map((h) => `Host(\`${h}\`)`).join(' || ');
  return `(${byHost}) && PathPrefix(\`${CONSOLE_PATH_PREFIX}\`)`;
}

export function consoleGateHash(target: ConsoleGateTarget): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: 2,
        namespace: target.namespace,
        hosts: target.hosts,
        service: target.service,
        redirectTo: target.redirectTo,
        sourceRange: CONSOLE_GATE_SOURCE_RANGE,
        redirectRegex: CONSOLE_GATE_REDIRECT_REGEX,
        priority: CONSOLE_GATE_PRIORITY,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

/**
 * The refusal in front of the identity provider's console: a route on every
 * name the provider answers on, matched before the provider's own routes. Its
 * first middleware sends the visitor to the dashboard, since sign-in flows with
 * no application behind them end on the console, or admits no source when no
 * dashboard address is known; the second admits no source, so a request the
 * first lets through is still refused. Sign-in paths are untouched.
 */
export function consoleGateManifests(
  target: ConsoleGateTarget,
): Array<Record<string, unknown>> {
  if (!target.hosts.length) {
    throw new ConsoleGateTargetError(
      'No public name is known for the identity provider',
    );
  }
  const labels = {
    'app.kubernetes.io/managed-by': 'flui',
    'flui.cloud/managed': 'true',
    'flui.cloud/component': CONSOLE_GATE_NAME,
  };
  const annotations = {
    [CONSOLE_GATE_HASH_ANNOTATION]: consoleGateHash(target),
  };
  const metadata = (name: string) => ({
    name,
    namespace: target.namespace,
    labels,
    annotations,
  });
  const route = {
    match: consoleGateMatch(target.hosts),
    kind: 'Rule',
    priority: CONSOLE_GATE_PRIORITY,
    middlewares: [
      { name: CONSOLE_GATE_NAME },
      { name: CONSOLE_GATE_REFUSE_NAME },
    ],
    services: [{ name: target.service.name, port: target.service.port }],
  };
  return [
    {
      apiVersion: TRAEFIK,
      kind: 'Middleware',
      metadata: metadata(CONSOLE_GATE_NAME),
      spec: target.redirectTo
        ? {
            redirectRegex: {
              regex: CONSOLE_GATE_REDIRECT_REGEX,
              replacement: target.redirectTo,
              permanent: false,
            },
          }
        : { ipAllowList: { sourceRange: CONSOLE_GATE_SOURCE_RANGE } },
    },
    {
      apiVersion: TRAEFIK,
      kind: 'Middleware',
      metadata: metadata(CONSOLE_GATE_REFUSE_NAME),
      spec: { ipAllowList: { sourceRange: CONSOLE_GATE_SOURCE_RANGE } },
    },
    {
      apiVersion: TRAEFIK,
      kind: 'IngressRoute',
      metadata: metadata(CONSOLE_GATE_NAME),
      spec: {
        entryPoints: ['websecure'],
        routes: [route],
        tls: {},
      },
    },
    {
      apiVersion: TRAEFIK,
      kind: 'IngressRoute',
      metadata: metadata(CONSOLE_GATE_WEB_NAME),
      spec: { entryPoints: ['web'], routes: [route] },
    },
  ];
}

export const CONSOLE_GATE_RESOURCES: Array<{ kind: string; name: string }> = [
  { kind: 'IngressRoute', name: CONSOLE_GATE_NAME },
  { kind: 'IngressRoute', name: CONSOLE_GATE_WEB_NAME },
  { kind: 'Middleware', name: CONSOLE_GATE_NAME },
  { kind: 'Middleware', name: CONSOLE_GATE_REFUSE_NAME },
];
