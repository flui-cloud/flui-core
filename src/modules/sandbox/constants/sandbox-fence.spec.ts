import {
  isSandboxAllowed,
  routeMatches,
  sandboxLevelOf,
  SANDBOX_ALLOWLIST,
  SANDBOX_AREAS,
} from './sandbox-fence';
import { findSandboxStandIn } from '../stand-in/sandbox-stand-in';

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
      ['GET', '/clusters/c1/applications/grouped'],
      ['POST', '/clusters/c1/applications'],
      ['GET', '/variables/applications/app-1'],
      ['PUT', '/variables/applications/app-1'],
      // Allowed at the route and narrowed in the response — see the projection
      // spec for what a guest actually receives.
      ['GET', '/infrastructure/clusters'],
      ['GET', '/projects'],
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
      ['GET', '/sandbox/session'],
      ['GET', '/sandbox/resume'],
      // The one destructive verb a guest holds. Which application is still
      // AppAccessGuard's answer; this only says the door exists.
      ['DELETE', '/applications/app-1'],
    ])('allows %s %s', (verb, path) => {
      expect(isSandboxAllowed(verb, path)).toBe(true);
    });
  });

  describe('what a guest may not do, called directly against the API', () => {
    it.each([
      // The management plane. None of these carry authorization of their own,
      // which is exactly why the fence has to be an allowlist.
      ['POST', '/infrastructure/clusters'],
      ['DELETE', '/infrastructure/clusters/c1'],
      ['POST', '/infrastructure/clusters/c1/workers'],
      ['GET', '/infrastructure/servers'],
      ['GET', '/access/ssh-keys'],
      ['POST', '/access/ssh-keys'],
      ['POST', '/access/bearer'],
      ['POST', '/auth/users'],
      ['GET', '/iam/bindings'],
      ['POST', '/iam/bindings'],
      ['GET', '/repositories'],
      ['POST', '/repositories/import'],
      ['GET', '/image-registry'],
      ['GET', '/mail/messages'],
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

      // The two reads the `/sandbox/**` wildcard used to carry with it: the
      // shape of the instance, and every other guest's namespace. Only
      // `sandbox:operate` was stopping them — one gate where the model wants
      // two — and neither is what the rule's `why` promises.
      ['GET', '/sandbox/capacity'],
      ['GET', '/sandbox/tenancies'],
      ['POST', '/sandbox/tenancies/user-guest-1/expire'],
    ])('refuses %s %s', (verb, path) => {
      expect(isSandboxAllowed(verb, path)).toBe(false);
    });

    /**
     * The key surface is opened by route, not by controller: the taxonomy, then
     * minting, then the two that switch an agent off again. Consent without the
     * opposite gesture is not consent, and neither of the two added hands over
     * anybody else's key — both select on the caller's own id.
     *
     * What stays shut is the rest of the controller, and `POST` is still the
     * only way to make one.
     */
    it('opens the key surface a guest needs, and no more of it', () => {
      expect(isSandboxAllowed('POST', '/auth/api-keys')).toBe(true);
      expect(isSandboxAllowed('GET', '/auth/api-key-groups')).toBe(true);
      expect(isSandboxAllowed('GET', '/auth/api-keys')).toBe(true);
      expect(isSandboxAllowed('DELETE', '/auth/api-keys/k1')).toBe(true);
      expect(isSandboxAllowed('POST', '/auth/users')).toBe(false);
      expect(isSandboxAllowed('DELETE', '/auth/api-key-groups')).toBe(false);
    });

    /**
     * Two reads and no writes: validating a manifest touches nothing, and
     * asking whether the cluster has room is the question that stops an install
     * that was going to fail on the quota. Deploying from a manifest stays shut
     * — it makes an application outside the route `assertCanCreate` watches.
     */
    it('opens the two calls an agent needs before it installs, and not the third', () => {
      expect(isSandboxAllowed('POST', '/catalog/validate')).toBe(true);
      expect(
        isSandboxAllowed(
          'GET',
          '/infrastructure/clusters/c1/resource-availability',
        ),
      ).toBe(true);
      expect(isSandboxAllowed('POST', '/applications/deploy-from-yaml')).toBe(
        false,
      );
    });

    /**
     * Where the agent speaks. Without it the credential above executes nothing,
     * and the trial's whole promise fails one step after the consent instead of
     * one step before it.
     */
    it('lets the agent endpoint through, and only by POST', () => {
      expect(isSandboxAllowed('POST', '/mcp')).toBe(true);
      expect(isSandboxAllowed('GET', '/mcp')).toBe(false);
    });

    it('refuses a verb it does not grant on a path it does', () => {
      expect(isSandboxAllowed('DELETE', '/clusters/c1/applications')).toBe(
        false,
      );
      expect(isSandboxAllowed('POST', '/catalog/gitea')).toBe(false);
    });

    /**
     * The reason the wildcard went: a route added under `/sandbox` later must
     * be closed until someone decides otherwise, which is how `capacity` and
     * `tenancies` had ended up open in the first place.
     */
    it('closes a route added under /sandbox that nobody has named', () => {
      expect(isSandboxAllowed('GET', '/sandbox/something-new')).toBe(false);
      expect(isSandboxAllowed('GET', '/sandbox/limits/detail')).toBe(false);
    });

    it('is not fooled by a path that merely starts like an allowed one', () => {
      expect(isSandboxAllowed('GET', '/applications')).toBe(false);
      expect(isSandboxAllowed('GET', '/sandbox')).toBe(false);
      expect(isSandboxAllowed('GET', '/catalogue/secret')).toBe(false);
    });
  });

  it('explains every refusal it makes wholesale', () => {
    for (const area of SANDBOX_AREAS) {
      expect(area.why.length).toBeGreaterThan(20);
    }
    expect(SANDBOX_AREAS.length).toBeGreaterThanOrEqual(6);
  });

  /**
   * The rules live in three files now, and this file concatenates them. That is
   * only safe while no path can be matched by two rules granting different
   * levels — otherwise `sandboxLevelOf` picks the first match, and the order the
   * three lists happen to be joined in would quietly decide what a guest is told
   * a section is. This keeps the join meaningless, which is the point.
   */
  it('never grants one path two different levels', () => {
    const asPath = (pattern: string) =>
      pattern
        .split('/')
        .map((s) => (s.startsWith(':') || s === '**' ? 'x' : s))
        .join('/');

    for (const rule of SANDBOX_ALLOWLIST) {
      const path = asPath(rule.pattern);
      for (const verb of rule.verbs) {
        const levels = new Set(
          SANDBOX_ALLOWLIST.filter(
            (other) =>
              other.verbs.includes(verb) && routeMatches(other.pattern, path),
          ).map((other) => other.level ?? 'full'),
        );
        expect([...levels]).toHaveLength(1);
      }
    }
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

  /**
   * Access is shown rather than shut, and the difference between the two is
   * where the answer comes from: every read below is served from the example
   * organisation and never reaches the handler, so no guest ever learns the
   * other guests' or the operator's accounts. The writes stay refused.
   */
  it('shows the access section without opening the real one', () => {
    for (const path of [
      '/auth/users',
      '/iam/roles',
      '/iam/grants',
      '/iam/groups',
      '/iam/resources',
      '/iam/principals',
    ]) {
      expect(isSandboxAllowed('GET', path)).toBe(true);
      expect(sandboxLevelOf('GET', path)).toBe('stand-in');
      expect(findSandboxStandIn('GET', path)).toBeDefined();
    }

    expect(isSandboxAllowed('POST', '/iam/grants')).toBe(false);
    expect(isSandboxAllowed('DELETE', '/iam/grants/g1')).toBe(false);
    expect(isSandboxAllowed('POST', '/auth/users')).toBe(false);
    expect(isSandboxAllowed('GET', '/iam/bindings')).toBe(false);
    expect(isSandboxAllowed('POST', '/me/permissions')).toBe(false);
  });

  /** Same again for the two sections whose real content is other people's. */
  it('shows mail and the model settings from the example world only', () => {
    for (const path of [
      '/mail/overview',
      '/mail/connections',
      '/mail/events',
      '/mail/suppressions',
      '/inference/providers',
      '/inference/connections',
    ]) {
      expect(sandboxLevelOf('GET', path)).toBe('stand-in');
      expect(findSandboxStandIn('GET', path)).toBeDefined();
    }
    expect(isSandboxAllowed('POST', '/mail/connections')).toBe(false);
    expect(isSandboxAllowed('POST', '/inference/connections')).toBe(false);
  });

  /**
   * Asked on every screen. Both answer the same thing to everyone and read
   * nothing of the instance, so they are real reads — and refusing them was
   * filling a guest's console with errors on pages that had nothing to do with
   * the assistant.
   */
  it('answers the two calls every screen makes', () => {
    expect(sandboxLevelOf('GET', '/assistant/v1/info')).toBe('read-only');
    expect(sandboxLevelOf('GET', '/assistant/v1/recommendations')).toBe(
      'read-only',
    );
    expect(findSandboxStandIn('GET', '/assistant/v1/info')).toBeUndefined();
    // Inference costs the operator money and is not offered.
    expect(isSandboxAllowed('POST', '/assistant/v1/chat/completions')).toBe(
      false,
    );
    expect(isSandboxAllowed('POST', '/assistant/v1/agent')).toBe(false);
  });
});
