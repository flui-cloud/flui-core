import {
  isSandboxAllowed,
  routeMatches,
  SANDBOX_ALLOWLIST,
  SANDBOX_DENIED_AREAS,
} from './sandbox-fence';

/**
 * The allowlist as a contract. Every route named here was read off the live
 * instance's route table, and each denied one is a door a guest — or an agent
 * acting for a guest — must find shut.
 */
describe('sandbox allowlist', () => {
  describe('route matching', () => {
    it('matches a literal path exactly', () => {
      expect(routeMatches('/auth/me', '/auth/me')).toBe(true);
      expect(routeMatches('/auth/me', '/auth/mercy')).toBe(false);
      expect(routeMatches('/auth/me', '/auth/me/keys')).toBe(false);
    });

    it('treats :param as exactly one segment', () => {
      expect(routeMatches('/applications/:id', '/applications/abc')).toBe(true);
      expect(routeMatches('/applications/:id', '/applications/abc/logs')).toBe(
        false,
      );
      expect(routeMatches('/applications/:id', '/applications')).toBe(false);
    });

    it('treats ** as one-or-more remaining segments', () => {
      expect(routeMatches('/applications/:id/**', '/applications/a/logs')).toBe(
        true,
      );
      expect(
        routeMatches('/applications/:id/**', '/applications/a/db/query'),
      ).toBe(true);
      expect(routeMatches('/applications/:id/**', '/applications/a')).toBe(
        false,
      );
    });
  });

  describe('what a guest may do', () => {
    it.each([
      ['GET', '/auth/me'],
      ['GET', '/clusters/c1/applications'],
      ['POST', '/clusters/c1/applications'],
      ['GET', '/applications/app-1'],
      ['PATCH', '/applications/app-1'],
      ['GET', '/applications/app-1/logs'],
      ['POST', '/applications/app-1/deploy'],
      ['POST', '/applications/app-1/db/query'],
      ['GET', '/observability/applications/app-1/logs'],
      ['GET', '/observability/applications/app-1/logs/volume'],
      ['GET', '/observability/applications/app-1/metrics'],
      ['GET', '/observability/applications/app-1/metrics/history'],
      ['GET', '/observability/applications/app-1/traffic'],
      ['GET', '/observability/applications/app-1/traffic/history'],
      ['GET', '/observability/applications/app-1/alerts'],
      ['GET', '/observability/clusters/c1/applications/metrics'],
      ['GET', '/observability/clusters/c1/applications/metrics/history'],
      ['GET', '/observability/clusters/c1/traffic'],
      ['GET', '/catalog'],
      ['GET', '/catalog/gitea'],
      ['POST', '/catalog/gitea/install'],
      ['GET', '/infrastructure/operations/op-1'],
      ['GET', '/sandbox/limits'],
    ])('allows %s %s', (verb, path) => {
      expect(isSandboxAllowed(verb, path)).toBe(true);
    });
  });

  describe('what a guest may not do, called directly against the API', () => {
    it.each([
      // The management plane. None of these carry authorization of their own,
      // which is exactly why the fence has to be an allowlist.
      ['GET', '/infrastructure/clusters'],
      ['POST', '/infrastructure/clusters'],
      ['DELETE', '/infrastructure/clusters/c1'],
      ['POST', '/infrastructure/clusters/c1/workers'],
      ['GET', '/infrastructure/servers'],
      ['GET', '/access/ssh-keys'],
      ['POST', '/access/ssh-keys'],
      ['POST', '/access/bearer'],
      ['GET', '/auth/users'],
      ['POST', '/auth/users'],
      ['POST', '/auth/api-keys'],
      ['GET', '/iam/bindings'],
      ['POST', '/iam/bindings'],
      ['GET', '/repositories'],
      ['POST', '/repositories/import'],
      ['GET', '/image-registry'],
      ['GET', '/mail/messages'],
      ['GET', '/projects'],
      ['POST', '/projects'],

      // Reading the platform's own configuration and secrets by namespace —
      // the hole F0 left open at the permission layer.
      ['GET', '/variables/clusters/c1/namespaces/flui-system'],
      ['PUT', '/variables/clusters/c1/namespaces/flui-system/flui-secrets'],
      ['GET', '/variables/clusters/c1/namespaces/kube-system/anything'],

      // Shared infrastructure a tenancy must not steer.
      ['POST', '/clusters/c1/dns-zone'],
      ['PUT', '/clusters/c1/dns-zone'],
      ['GET', '/clusters/c1/gateway/routes'],
      ['POST', '/clusters/c1/firewalls'],
      ['POST', '/full-migration/start'],
      ['GET', '/backups'],
      ['POST', '/backups/run'],

      // Cluster log search is deliberately admin-only; sandbox guests use the
      // app-scoped route, whose namespace and container come from the app row.
      ['GET', '/observability/clusters/c1/apps/logs'],
      ['GET', '/observability/clusters/c1/apps/logs/volume'],
    ])('refuses %s %s', (verb, path) => {
      expect(isSandboxAllowed(verb, path)).toBe(false);
    });

    it('refuses a verb it does not grant on a path it does', () => {
      expect(isSandboxAllowed('DELETE', '/clusters/c1/applications')).toBe(
        false,
      );
      expect(isSandboxAllowed('POST', '/catalog/gitea')).toBe(false);
    });

    it('is not fooled by a path that merely starts like an allowed one', () => {
      expect(isSandboxAllowed('GET', '/applications')).toBe(false);
      expect(isSandboxAllowed('GET', '/sandbox')).toBe(false);
      expect(isSandboxAllowed('GET', '/catalogue/secret')).toBe(false);
    });
  });

  it('explains every refusal it makes wholesale', () => {
    for (const area of SANDBOX_DENIED_AREAS) {
      expect(area.why.length).toBeGreaterThan(20);
    }
    expect(SANDBOX_DENIED_AREAS.length).toBeGreaterThanOrEqual(6);
  });

  it('gives a reason for every door it leaves open', () => {
    for (const rule of SANDBOX_ALLOWLIST) {
      expect(rule.why.length).toBeGreaterThan(10);
      expect(rule.verbs.length).toBeGreaterThan(0);
    }
  });

  /**
   * Written from the paths the routes actually register, not from the module a
   * controller happens to live in. `/iam/me/**` looked right and matched nothing,
   * so a guest was refused the two calls that decide what the interface renders —
   * a fence that stops the guest's own dashboard from loading is not a stricter
   * fence, it is a broken one.
   */
  it('lets a guest load its own interface', () => {
    expect(isSandboxAllowed('GET', '/me/permissions')).toBe(true);
    expect(isSandboxAllowed('GET', '/me/sections')).toBe(true);
    expect(isSandboxAllowed('GET', '/auth/me')).toBe(true);
    expect(isSandboxAllowed('GET', '/sandbox/session')).toBe(true);
  });

  it('still refuses the management side of IAM', () => {
    expect(isSandboxAllowed('GET', '/iam/grants')).toBe(false);
    expect(isSandboxAllowed('POST', '/iam/grants')).toBe(false);
    expect(isSandboxAllowed('GET', '/iam/principals')).toBe(false);
    expect(isSandboxAllowed('POST', '/me/permissions')).toBe(false);
  });
});
