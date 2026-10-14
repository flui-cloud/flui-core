import {
  CONSOLE_GATE_HASH_ANNOTATION,
  CONSOLE_GATE_PRIORITY,
  consoleGateHash,
  consoleGateManifests,
  consoleGateMatch,
  dashboardRedirectTarget,
  hostsInRouteMatch,
  identityProviderHosts,
  isConsoleOpen,
  isWindowExpired,
} from './identity-console-gate.core';
import { BRIDGE_ROUTE_PRIORITY } from '../../dns/utils/endpoint-bridge.core';

const target = {
  namespace: 'flui-system',
  hosts: ['auth.example.com', 'auth-203-0-113-10.nip.io'],
  service: { name: 'zitadel', port: 8080 },
  redirectTo: null,
};

describe('the identity console refusal', () => {
  const [middleware, refuse, secure, web] = consoleGateManifests(target);

  it('sends a console visitor to the dashboard, environment.json included, when the dashboard address is known', () => {
    const [redirect] = consoleGateManifests({
      ...target,
      redirectTo: 'https://console.example.com/',
    });
    expect(redirect.spec).toEqual({
      redirectRegex: {
        regex: '^.*$',
        replacement: 'https://console.example.com/',
        permanent: false,
      },
    });
    const regex = new RegExp(
      (
        redirect.spec as { redirectRegex: { regex: string } }
      ).redirectRegex.regex,
    );
    for (const url of [
      'https://auth.example.com/ui/console',
      'https://auth.example.com/ui/console/',
      'https://auth.example.com/ui/console/assets/environment.json',
      'https://auth.example.com/ui/console/users/me?x=1',
    ]) {
      expect(regex.test(url)).toBe(true);
    }
    expect(
      consoleGateHash({
        ...target,
        redirectTo: 'https://console.example.com/',
      }),
    ).not.toBe(consoleGateHash(target));
  });

  it('redirects or refuses a console path whatever its encoding, since the router matches the decoded path and the redirect sees the raw one', () => {
    const manifests = consoleGateManifests({
      ...target,
      redirectTo: 'https://console.example.com/',
    });
    const regex = new RegExp(
      (
        manifests[0].spec as { redirectRegex: { regex: string } }
      ).redirectRegex.regex,
    );
    for (const url of [
      'https://auth.example.com/ui/%63onsole/',
      'https://auth.example.com/ui%2Fconsole/',
      'https://auth.example.com/ui/console%2F..%2Fconsole',
      'https://auth.example.com/%75i/console',
    ]) {
      expect(regex.test(url)).toBe(true);
    }
    const middlewares = manifests.filter((m) => m.kind === 'Middleware');
    expect(
      middlewares.map((m) => (m.metadata as { name: string }).name),
    ).toEqual(['identity-console-gate', 'identity-console-gate-refuse']);
    expect(middlewares[1].spec).toEqual({
      ipAllowList: { sourceRange: ['255.255.255.255/32'] },
    });
    for (const route of manifests.filter((m) => m.kind === 'IngressRoute')) {
      expect(
        (route.spec as { routes: Array<{ middlewares: unknown[] }> }).routes[0]
          .middlewares,
      ).toEqual([
        { name: 'identity-console-gate' },
        { name: 'identity-console-gate-refuse' },
      ]);
    }
  });

  it('refuses every source on the console path, and nothing else, when no dashboard address is known', () => {
    expect(middleware).toMatchObject({
      kind: 'Middleware',
      metadata: { name: 'identity-console-gate', namespace: 'flui-system' },
      spec: { ipAllowList: { sourceRange: ['255.255.255.255/32'] } },
    });
    expect(refuse).toMatchObject({
      kind: 'Middleware',
      metadata: { name: 'identity-console-gate-refuse' },
      spec: { ipAllowList: { sourceRange: ['255.255.255.255/32'] } },
    });
    const match = consoleGateMatch(target.hosts);
    expect(match).toBe(
      '(Host(`auth.example.com`) || Host(`auth-203-0-113-10.nip.io`)) && PathPrefix(`/ui/console`)',
    );
    for (const path of [
      '/ui/login',
      '/oauth/v2',
      '/oidc/v1',
      '/.well-known',
      '/idps/callback',
      '/assets/v1',
      '/v2',
      '/management/v1',
      '/admin/v1',
      '/auth/v1',
      '/zitadel.',
    ]) {
      expect(match).not.toContain(path);
    }
  });

  it('wins over the provider and migration bridge routes on both entrypoints, below the certificate solver, through the refusal', () => {
    for (const route of [secure, web]) {
      const spec = route.spec as {
        routes: Array<{ priority: number; middlewares: unknown[] }>;
      };
      expect(route.kind).toBe('IngressRoute');
      expect(spec.routes[0].priority).toBe(CONSOLE_GATE_PRIORITY);
      expect(spec.routes[0].priority).toBeGreaterThan(BRIDGE_ROUTE_PRIORITY);
      expect(spec.routes[0].priority).toBeLessThan(20_000_000);
      expect(spec.routes[0].middlewares).toEqual([
        { name: 'identity-console-gate' },
        { name: 'identity-console-gate-refuse' },
      ]);
    }
    expect(secure.spec).toMatchObject({ entryPoints: ['websecure'], tls: {} });
    expect(web.spec).toMatchObject({ entryPoints: ['web'] });
    expect(web.spec).not.toHaveProperty('tls');
  });

  it('stamps one hash that changes with the hosts', () => {
    const hash = consoleGateHash(target);
    for (const m of [middleware, refuse, secure, web]) {
      expect(
        (m.metadata as { annotations: Record<string, string> }).annotations[
          CONSOLE_GATE_HASH_ANNOTATION
        ],
      ).toBe(hash);
    }
    expect(
      consoleGateHash({ ...target, hosts: ['auth.example.com'] }),
    ).not.toBe(hash);
  });

  it('refuses to build a rule without a host, rather than matching every site', () => {
    expect(() => consoleGateManifests({ ...target, hosts: [] })).toThrow(
      /No public name/,
    );
  });
});

describe('the names the identity provider answers on', () => {
  it('reads Host matchers in both rule syntaxes', () => {
    expect(hostsInRouteMatch('Host(`auth.example.com`)')).toEqual([
      'auth.example.com',
    ]);
    expect(hostsInRouteMatch('Host(`a.example.com`, `b.example.com`)')).toEqual(
      ['a.example.com', 'b.example.com'],
    );
    expect(hostsInRouteMatch(undefined)).toEqual([]);
  });

  it('merges the bootstrap route, the endpoints and the issuer, once each, and drops anything that is not a hostname', () => {
    expect(
      identityProviderHosts({
        routeMatches: ['Host(`auth-203-0-113-10.nip.io`)'],
        endpointHosts: ['Auth.Example.com', null, 'bad host`) || Host(`x'],
        issuer: 'https://auth.example.com',
      }),
    ).toEqual(['auth-203-0-113-10.nip.io', 'auth.example.com']);
  });
});

describe('the dashboard address a refused visitor is sent to', () => {
  it('keeps only the origin of a public http(s) address', () => {
    expect(
      dashboardRedirectTarget('https://console.example.com/login?x=1'),
    ).toBe('https://console.example.com/');
    expect(
      dashboardRedirectTarget('https://web-203-0-113-10.nip.io:8443'),
    ).toBe('https://web-203-0-113-10.nip.io:8443/');
  });

  it('knows none for an empty, local, malformed or credentialed address', () => {
    for (const url of [
      undefined,
      '',
      'http://localhost:4200',
      'http://127.0.0.1:4200',
      'not a url',
      'javascript:alert(1)',
      'https://user:pw@console.example.com',
    ]) {
      expect(dashboardRedirectTarget(url)).toBeNull();
    }
  });
});

describe('the open window', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  it('is open only before its end', () => {
    expect(isConsoleOpen({ openUntil: null }, now)).toBe(false);
    expect(
      isConsoleOpen({ openUntil: new Date('2026-10-14T12:00:01Z') }, now),
    ).toBe(true);
    expect(isConsoleOpen({ openUntil: now }, now)).toBe(false);
    expect(isWindowExpired({ openUntil: now }, now)).toBe(true);
    expect(isWindowExpired({ openUntil: null }, now)).toBe(false);
  });
});
