import {
  isSandboxAllowed,
  routeMatches,
  sandboxLevelOf,
  SANDBOX_ALLOWLIST,
  SANDBOX_AREAS,
} from './sandbox-fence';
import { findSandboxStandIn } from '../stand-in/sandbox-stand-in';
import { SHOWCASE_BANNER } from '../../applications/constants/showcase-banner';
import { handIsToldTo } from '../../operating-context/hands/entry-hands';
import { EntryScope } from '../../operating-context/operating-context.core';
import { PrincipalAccess } from '../../iam/interfaces/iam.types';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

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
      ['GET', '/showcase'],
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
      // Names every tenancy on the cluster and how much disk each one takes,
      // so it answers "who else is here" — a question the sandbox exists to
      // refuse. It sits one segment past `/infrastructure/clusters/:id`, which
      // IS shown to a guest, which is exactly the shape a prefix match would
      // wave through.
      ['GET', '/infrastructure/clusters/c1/storage/usage'],
      ['GET', '/infrastructure/servers'],
      ['GET', '/access/ssh-keys'],
      ['POST', '/access/ssh-keys'],
      ['POST', '/access/bearer'],
      ['POST', '/auth/users'],
      ['GET', '/iam/bindings'],
      ['POST', '/iam/bindings'],
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
     * Validating a manifest touches nothing, and asking whether the cluster has
     * room is the question that stops an install that was going to fail on the
     * quota.
     *
     * Deploying from a manifest is open too. `assertCanCreate` pins the body's
     * `clusterId` to the tenancy's own cluster, `DeployFromYamlDto` names none of
     * the fields `sandbox-placement.util.ts` strips, and the published
     * Application schema is `additionalProperties: false` at every level, so a
     * manifest cannot smuggle a placement past `validateApplicationManifest`.
     */
    it('opens the calls an agent needs before it installs', () => {
      expect(isSandboxAllowed('POST', '/catalog/validate')).toBe(true);
      expect(
        isSandboxAllowed(
          'GET',
          '/infrastructure/clusters/c1/resource-availability',
        ),
      ).toBe(true);
      expect(isSandboxAllowed('POST', '/applications/deploy-from-yaml')).toBe(
        true,
      );
      expect(isSandboxAllowed('POST', '/clusters/c1/applications')).toBe(true);
      expect(isSandboxAllowed('POST', '/catalog/gitea/install')).toBe(true);
    });

    /**
     * The git entrance a guest walks through with their own token, and the
     * parts of it that belong to whoever runs the instance.
     */
    it('opens building from the guest’s own repositories with a personal token', () => {
      for (const [verb, path] of [
        ['GET', '/repositories/github/setup/status'],
        ['GET', '/repositories/github/status'],
        ['POST', '/repositories/github/validate-pat'],
        ['POST', '/repositories/github/connect-pat'],
        ['POST', '/repositories/github/disconnect'],
        ['GET', '/repositories'],
        ['GET', '/repositories/available'],
        ['POST', '/repositories/import'],
        ['GET', '/repositories/r1'],
        ['DELETE', '/repositories/r1'],
        ['GET', '/repositories/r1/branches'],
        ['GET', '/repositories/r1/manifests'],
        ['POST', '/repositories/r1/map/apply'],
        ['POST', '/applications/deploy-from-yaml'],
        ['POST', '/templates/nextjs/use'],
        ['GET', '/repositories/github-app/install-url'],
        ['POST', '/repositories/github-app/rescan-installations'],
        ['GET', '/repositories/github-app/packages-pat/status'],
      ] as const) {
        expect(isSandboxAllowed(verb, path)).toBe(true);
      }
    });

    /**
     * A GET the fence admits skips the permission check, so anything opened
     * here is answered by its handler alone. The instance's own GitHub setup
     * and the App installations of everybody on it must never be among them.
     */
    it('keeps the instance’s GitHub setup and the App routes shut', () => {
      for (const [verb, path] of [
        ['GET', '/repositories/github/setup/health'],
        ['POST', '/repositories/github/setup/pat'],
        ['POST', '/repositories/github/setup/github-app'],
        ['POST', '/repositories/github/setup/github-app/manifest-start'],
        ['DELETE', '/repositories/github/setup'],
        ['GET', '/repositories/github-app/installations'],
        ['DELETE', '/repositories/github-app/installations/1'],
        ['POST', '/repositories/github-app/packages-pat'],
        ['PUT', '/repositories/github-app/packages-pat/rotate'],
        ['DELETE', '/repositories/github-app/packages-pat'],
        ['PATCH', '/repositories/r1'],
        // Pushes reach Flui through the generated workflow; the repository
        // webhook these manage points at a route nothing serves.
        ['POST', '/repositories/r1/webhook'],
        ['DELETE', '/repositories/r1/webhook'],
        ['GET', '/repositories/r1/webhooks'],
        ['GET', '/templates/nextjs'],
      ] as const) {
        expect(isSandboxAllowed(verb, path)).toBe(false);
      }
    });

    it('tells a guest the git entrance is theirs, and what happens to the token', () => {
      const area = SANDBOX_AREAS.find((a) => a.key === 'repositories');
      expect(area?.level).toBe('full');
      expect(area?.why).toContain('token');
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

    /**
     * The consent, whole.
     *
     * A guest could answer its agent and could take a standing permission back
     * while the register of what either produced was refused at the door — so
     * the demo shipped the half of the panel that hands power out and not the
     * half that shows what it did. Revoking without it is a change of mind.
     *
     * The rows are pinned to the caller inside the handler, so opening the
     * route opens nobody else's register: see `agent-activity.service.spec.ts`,
     * which is the other half of this claim.
     */
    it('lets a guest read its own register, and nothing writes to it', () => {
      expect(isSandboxAllowed('GET', '/agent/activity')).toBe(true);
      expect(isSandboxAllowed('GET', '/agent/activity/identities')).toBe(true);
      expect(
        isSandboxAllowed('GET', '/agent/activity/11111111-1111-4111-8111-1'),
      ).toBe(true);

      // No verb but GET, on any of the three. The register is written by the
      // act; a route that let a caller add to it would be a way to write the
      // record of what one did.
      for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(isSandboxAllowed(verb, '/agent/activity')).toBe(false);
        expect(isSandboxAllowed(verb, '/agent/activity/x')).toBe(false);
      }
    });

    /**
     * `full`, not `read-only`, and the difference is a sentence a visitor
     * reads. `read-only` is printed as a standing caption meaning "a paying
     * instance changes this and you cannot" — which would be false here, since
     * the register has no write route for anybody at all.
     */
    it('calls the register what it is, rather than labelling it limited', () => {
      expect(sandboxLevelOf('GET', '/agent/activity')).toBe('full');
      expect(sandboxLevelOf('GET', '/agent/activity/identities')).toBe('full');
      expect(sandboxLevelOf('GET', '/agent/activity/act-1')).toBe('full');
      expect(sandboxLevelOf('GET', '/agent/proposals')).toBe('full');
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

  /**
   * The third thing the fence has to be able to say.
   *
   * Two of them were already there — this is yours, and this is not yours at
   * all — and the showcase is the one in between: not yours, and you see it
   * anyway. It is also the only place where the two halves of the fence
   * disagreed: a tenancy is written a `showcase_viewer` binding when it is
   * provisioned, and the route was refused regardless, because an allowlist
   * refuses whatever nobody named. The outer half winning is the design working;
   * it just meant the showcase was unreadable by the only people it is for.
   */
  it('shows a guest the showcase and refuses every hand laid on it', () => {
    expect(isSandboxAllowed('GET', '/showcase')).toBe(true);
    expect(sandboxLevelOf('GET', '/showcase')).toBe('read-only');
    // Real, and not answered from the example world: that these applications
    // are actually running is the entire claim the showcase makes.
    expect(findSandboxStandIn('GET', '/showcase')).toBeUndefined();

    // Deciding who *sees* an application is the operator's, so it is refused at
    // the door as well as at the permission behind it.
    expect(isSandboxAllowed('PUT', '/showcase/immich')).toBe(false);
    expect(isSandboxAllowed('DELETE', '/showcase/immich')).toBe(false);
    expect(isSandboxAllowed('POST', '/showcase')).toBe(false);
    // The wildcard that was deliberately not written: nothing under the prefix
    // is open in advance of somebody deciding it should be.
    expect(isSandboxAllowed('GET', '/showcase/immich')).toBe(false);
  });

  /**
   * The banner is one sentence with one home. It is the showcase's own constant,
   * read here rather than restated, so the section label a guest is shown and
   * the promise the showcase makes cannot end up being two different promises.
   */
  it('introduces the showcase with the showcase’s own sentence', () => {
    const area = SANDBOX_AREAS.find((a) => a.key === 'showcase');
    expect(area?.level).toBe('read-only');
    expect(area?.why).toBe(SHOWCASE_BANNER);
    expect(sandboxLevelOf('GET', '/showcase')).toBe(area?.level);
  });

  /**
   * The rules of the place, reaching the person acting in it.
   *
   * Until this pair of rules existed the fence did not name `/operating-context`
   * at all, so a guest was answered `closed` on all seven routes: the notes were
   * built, and the only readers they reached were the people who had written
   * them. Read-only and real — a guest acts for real here, and an agent that
   * acted on invented practices would distribute broken applications
   * confidently.
   */
  it('shows a guest how this installation is run, and lets it change none of it', () => {
    expect(isSandboxAllowed('GET', '/operating-context')).toBe(true);
    expect(isSandboxAllowed('GET', '/operating-context/advice')).toBe(true);
    expect(sandboxLevelOf('GET', '/operating-context')).toBe('read-only');
    expect(sandboxLevelOf('GET', '/operating-context/advice')).toBe(
      'read-only',
    );
    // Real, not answered from the example world: an agent handed invented
    // practices acts on them, which is worse than being handed none.
    expect(
      findSandboxStandIn('GET', '/operating-context/advice'),
    ).toBeUndefined();

    // "Nella demo l'ospite legge e non scrive." All four writes, refused at the
    // door as well as by the covering check behind it.
    expect(isSandboxAllowed('POST', '/operating-context')).toBe(false);
    expect(isSandboxAllowed('PATCH', '/operating-context/n1')).toBe(false);
    expect(isSandboxAllowed('DELETE', '/operating-context/n1')).toBe(false);
    expect(isSandboxAllowed('POST', '/operating-context/n1/confirm')).toBe(
      false,
    );

    // Named routes, no wildcard: whatever is mounted under this prefix next is
    // shut until somebody decides otherwise.
    expect(isSandboxAllowed('GET', '/operating-context/n1')).toBe(false);
  });

  /**
   * The three reads a guest is refused here, refused on purpose.
   *
   * All three were `closed` because nobody named them, which is the fence
   * working — an allowlist refuses what nobody wrote down — and is also how a
   * decision nobody made comes to look like a decision. Written out so that
   * re-opening one is an argument against a stated reason rather than the
   * discovery of an oversight.
   *
   *  - **`/probes`** is the catalogue a note's check is picked from, and
   *    **`/reach`** says who would read a note at a level before it is
   *    written. Both are an author's tools, and rule 4 is that in the trial the
   *    guest reads and does not write. Neither is withheld for what it
   *    discloses: the catalogue publishes the *names* of fields a note may lean
   *    on — `status`, `replicas`, `port` — which a guest already reads off its
   *    own application, and the reach line is a pure function of the two words
   *    the caller just supplied. They are shut because they answer a question a
   *    guest does not have, not because the answer would cost anything;
   *
   *  - **`/archive`** is the notes that were **retired**. The reason the two
   *    open rules are open (decision 148) is that a guest acts here for real
   *    and should act by the rules in force. A withdrawn note is by definition
   *    not one of those, so that reason does not reach this route. What the
   *    archive is *for* is the question "who do I ask before writing this rule
   *    again", which belongs to somebody who may write the rule — and the field
   *    that answers it, the hand that withdrew the note, is refused to a guest
   *    by the signature gate anyway. The test below checks that gate rather
   *    than assuming it, because "the name would leak" is the one reason for
   *    this refusal that would have been **false**.
   */
  it('names the three operating-context reads it refuses, and why', () => {
    for (const path of [
      '/operating-context/probes',
      '/operating-context/reach',
      '/operating-context/archive',
    ]) {
      expect(isSandboxAllowed('GET', path)).toBe(false);
      expect(sandboxLevelOf('GET', path)).toBe('closed');
    }

    // The two that stay open, asserted beside them: the refusals above are
    // about which reads, not about the section being shut.
    expect(isSandboxAllowed('GET', '/operating-context')).toBe(true);
    expect(isSandboxAllowed('GET', '/operating-context/advice')).toBe(true);
  });

  /**
   * The gate before the field, checked from the side the gate exists for.
   *
   * Decision 175 put this gate in because `GET /operating-context` crosses this
   * fence: a signature delivered with a global practice would publish the names
   * of the people who run an installation to anybody who opened a trial. It was
   * written for the two open routes; `archivedBy` arrived later, on a third.
   *
   * Checked here rather than assumed, and *before* the decision above rather
   * than after it, because the order matters: a route refused out of a fear
   * that turns out to be unfounded is a refusal nobody can argue with. It is
   * unfounded. Every hand on every note is asked of this one function, and the
   * service asks it **before** it looks a name up, so no route can deliver a
   * name to a guest by having forgotten to filter one.
   *
   * The pinned property is therefore not "the archive is safe to open" — that
   * is a product question answered above — but "if it is opened, no name goes
   * through with it".
   */
  it('never tells a guest whose hand is on a note, whatever the note', () => {
    const guest: PrincipalAccess = {
      isAdmin: false,
      globalPermissions: new Set([IAM_PERMISSION.APP_READ]),
      scopedGrants: [],
      isSandbox: true,
    };
    const levels: EntryScope[] = [
      { scopeType: 'global', scopeRef: null },
      { scopeType: 'cluster', scopeRef: 'c1' },
      { scopeType: 'selector', selector: { clusterId: 'c1' } },
    ];

    for (const scope of levels) {
      expect(
        handIsToldTo(
          guest,
          scope,
          IAM_PERMISSION.APP_READ,
          'user-guest',
          'user-operator',
        ),
      ).toBe(false);
    }

    // The same reader with the sandbox mark off is told, so the refusals above
    // are the mark doing the work and not an empty set of grants.
    for (const scope of levels) {
      expect(
        handIsToldTo(
          { ...guest, isAdmin: true, isSandbox: false },
          scope,
          IAM_PERMISSION.APP_READ,
          'user-someone',
          'user-operator',
        ),
      ).toBe(true);
    }
  });

  it('names the operating context in the list of limits a guest is shown', () => {
    const area = SANDBOX_AREAS.find((a) => a.key === 'operating-context');
    expect(area?.level).toBe('read-only');
    expect(sandboxLevelOf('GET', '/operating-context')).toBe(area?.level);
    expect(area?.why).toContain('agent');
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
  });

  /**
   * Inference costs the operator money, and that is still true — so the door
   * that opened is the one that thinks before it spends. A fresh turn on
   * `/agent` is routed past the on-topic guard first; `chat/completions` is the
   * raw pass-through and stays shut, because a demo that proxies a language
   * model is a demo somebody will use as one.
   */
  it('opens the assistant by the door that thinks first, and only that one', () => {
    expect(isSandboxAllowed('POST', '/assistant/v1/agent')).toBe(true);
    expect(isSandboxAllowed('POST', '/assistant/v1/agent/stream')).toBe(true);
    expect(isSandboxAllowed('GET', '/assistant/v1/usage')).toBe(true);
    expect(isSandboxAllowed('POST', '/assistant/v1/chat/completions')).toBe(
      false,
    );
  });
});
