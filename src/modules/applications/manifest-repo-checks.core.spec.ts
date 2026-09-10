import {
  allChecksFor,
  repoChecksFor,
  type ManifestCheck,
  type ManifestClaims,
  type ManifestSelfFacts,
  type ManifestShapeFacts,
  type RepoBlocker,
  type RepoDeclaredHealth,
  type RepoDeclaredService,
  type RepoFacts,
  type RepoFactsRead,
  type RepoReadBoundary,
  type RepoRoute,
  type RepoUnit,
} from './manifest-repo-checks.core';
import type { ManifestFacts } from './manifest-checks.core';

const byId = (checks: ManifestCheck[], id: string): ManifestCheck =>
  checks.find((c) => c.id === id)!;

const boundary = (over: Partial<RepoReadBoundary> = {}): RepoReadBoundary => ({
  commitSha: 'abc1234def5678',
  ref: 'main',
  files: 12,
  listingComplete: true,
  bytesRead: 4096,
  contentComplete: true,
  skipped: { symlinks: 0, oversize: 0, other: 0 },
  notFound: [],
  highDensityUnread: [],
  ...over,
});

const readRepo = (over: Partial<RepoFactsRead> = {}): RepoFactsRead => ({
  read: true,
  boundary: boundary(),
  files: ['Dockerfile', 'src/index.js', 'package.json'],
  dockerfiles: ['Dockerfile'],
  port: { value: 8080, source: 'Dockerfile:3 EXPOSE 8080' },
  declaredHealth: [],
  routes: [],
  routesEnumerable: false,
  envKeysReadByCode: [],
  declaredServices: [],
  units: [{ name: 'app', root: '', dockerfile: 'Dockerfile' }],
  blockers: [],
  ...over,
});

const claims = (over: Partial<ManifestClaims> = {}): ManifestClaims => ({
  dockerfilePath: 'Dockerfile',
  buildContext: null,
  buildStrategy: 'dockerfile',
  port: 8080,
  healthPath: null,
  declaredEnvKeys: [],
  suppliedEnvKeys: [],
  providedServiceKinds: [],
  unitPath: null,
  ...over,
});

const shape = (over: Partial<ManifestShapeFacts> = {}): ManifestShapeFacts => ({
  apiVersion: 'flui.cloud/v1beta1',
  envForm: 'map',
  inertFields: [],
  resolvedBuildStrategy: 'dockerfile',
  ...over,
});

const facts = (over: Partial<ManifestFacts> = {}): ManifestFacts => ({
  clusterFound: true,
  clusterReady: true,
  clusterName: 'control-cluster',
  repositoryConnected: true,
  repoFullName: 'acme/api',
  githubConnected: true,
  registryCredential: true,
  existingApp: null,
  capacity: {
    fits: true,
    requiredCpuMc: 250,
    requiredMemoryMi: 256,
    availableCpuMc: 1800,
    availableMemoryMi: 4096,
  },
  exposure: 'public',
  dnsZone: 'example.com',
  fqdn: null,
  targetIsControlCluster: false,
  hasWorkloadCluster: true,
  ...over,
});

describe('repo-snapshot', () => {
  it('pass: the archive was read whole', () => {
    const checks = repoChecksFor(claims(), readRepo());
    const c = byId(checks, 'repo-snapshot');
    expect(c.status).toBe('pass');
    expect(c.detail).toContain('abc1234');
  });

  it('unknown: the repository could not be read at all, and nothing else in the family fires', () => {
    const unread: RepoFacts = {
      read: false,
      reason: 'no-credential',
      repoFullName: 'acme/api',
      ref: 'main',
    };
    const checks = repoChecksFor(claims(), unread);
    expect(checks).toHaveLength(1);
    expect(checks[0].id).toBe('repo-snapshot');
    expect(checks[0].status).toBe('unknown');
    expect(checks[0].detail).toContain('acme/api');
  });

  it('unknown: read, but the listing was truncated', () => {
    const checks = repoChecksFor(
      claims(),
      readRepo({ boundary: boundary({ listingComplete: false }) }),
    );
    expect(byId(checks, 'repo-snapshot').status).toBe('unknown');
  });
});

describe('repo-dockerfile', () => {
  it('pass: the named Dockerfile is in the listing', () => {
    const checks = repoChecksFor(
      claims({ dockerfilePath: 'Dockerfile' }),
      readRepo({ files: ['Dockerfile', 'src/index.js'] }),
    );
    expect(byId(checks, 'repo-dockerfile').status).toBe('pass');
  });

  it('fail: the complete listing does not contain the named file', () => {
    const checks = repoChecksFor(
      claims({ dockerfilePath: 'docker/Dockerfile.prod' }),
      readRepo({
        files: ['Dockerfile', 'src/index.js'],
        boundary: boundary({ listingComplete: true }),
      }),
    );
    const c = byId(checks, 'repo-dockerfile');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('docker/Dockerfile.prod');
  });

  it('unknown: the listing was truncated, so absence cannot be proven', () => {
    const checks = repoChecksFor(
      claims({ dockerfilePath: 'docker/Dockerfile.prod' }),
      readRepo({
        files: ['Dockerfile'],
        boundary: boundary({ listingComplete: false }),
      }),
    );
    expect(byId(checks, 'repo-dockerfile').status).toBe('unknown');
  });

  // The form all thirteen official templates ship
  // (`flui-template-nextjs-16/flui.yaml:9`), against a listing that carries
  // `Dockerfile`. Compared verbatim it used to read as a demonstrable fail.
  it('pass: ./Dockerfile, the form every official template writes', () => {
    const checks = repoChecksFor(
      claims({ dockerfilePath: './Dockerfile' }),
      readRepo({ files: ['Dockerfile', 'src/index.js'] }),
    );
    const c = byId(checks, 'repo-dockerfile');
    expect(c.status).toBe('pass');
    expect(c.detail).toContain('./Dockerfile');
  });

  it('pass: a leading slash and a ./ prefix on a nested path both normalise', () => {
    expect(
      byId(
        repoChecksFor(
          claims({ dockerfilePath: './apps/api/Dockerfile' }),
          readRepo({ files: ['apps/api/Dockerfile'] }),
        ),
        'repo-dockerfile',
      ).status,
    ).toBe('pass');
    expect(
      byId(
        repoChecksFor(
          claims({ dockerfilePath: '/apps/api/Dockerfile' }),
          readRepo({ files: ['apps/api/Dockerfile'] }),
        ),
        'repo-dockerfile',
      ).status,
    ).toBe('pass');
  });

  it('fail: the normalisation does not turn a wrong path into a right one', () => {
    const checks = repoChecksFor(
      claims({ dockerfilePath: './docker/Dockerfile.prod' }),
      readRepo({ files: ['Dockerfile'] }),
    );
    expect(byId(checks, 'repo-dockerfile').status).toBe('fail');
  });

  it('warn: no Dockerfile named, and the repository has more than one', () => {
    const checks = repoChecksFor(
      claims({ dockerfilePath: null }),
      readRepo({ dockerfiles: ['Dockerfile', 'services/worker/Dockerfile'] }),
    );
    expect(byId(checks, 'repo-dockerfile').status).toBe('warn');
  });
});

describe('repo-build-context', () => {
  it('pass: no context set, the repository root always exists', () => {
    const checks = repoChecksFor(claims({ buildContext: null }), readRepo());
    expect(byId(checks, 'repo-build-context').status).toBe('pass');
  });

  // `context: .` is what `flui app manifest` prints (cli/src/commands/app/
  // manifest.ts:98) and what resolveBuildPaths assumes. No path in a listing
  // starts with `./`, so a prefix search used to call it an empty directory.
  it('pass: context ".", the form the CLI guide prints', () => {
    for (const written of ['.', './', '']) {
      const checks = repoChecksFor(
        claims({ buildContext: written, dockerfilePath: './Dockerfile' }),
        readRepo({ files: ['Dockerfile', 'src/index.js'] }),
      );
      const c = byId(checks, 'repo-build-context');
      expect(c.status).toBe('pass');
      expect(c.detail).toContain('repository root');
    }
  });

  it('pass: a nested context written with a ./ prefix and a trailing slash', () => {
    const checks = repoChecksFor(
      claims({
        buildContext: './apps/api/',
        dockerfilePath: './apps/api/Dockerfile',
      }),
      readRepo({ files: ['apps/api/Dockerfile', 'apps/api/src/index.js'] }),
    );
    expect(byId(checks, 'repo-build-context').status).toBe('pass');
  });

  it('fail: the complete listing has nothing under the named context', () => {
    const checks = repoChecksFor(
      claims({ buildContext: 'apps/api', dockerfilePath: null }),
      readRepo({
        files: ['Dockerfile', 'src/index.js'],
        boundary: boundary({ listingComplete: true }),
      }),
    );
    const c = byId(checks, 'repo-build-context');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('apps/api');
  });

  it('unknown: the listing was truncated', () => {
    const checks = repoChecksFor(
      claims({ buildContext: 'apps/api', dockerfilePath: null }),
      readRepo({
        files: ['Dockerfile'],
        boundary: boundary({ listingComplete: false }),
      }),
    );
    expect(byId(checks, 'repo-build-context').status).toBe('unknown');
  });

  it('warn: the context exists but the named Dockerfile is outside it', () => {
    const checks = repoChecksFor(
      claims({ buildContext: 'apps/api', dockerfilePath: 'Dockerfile' }),
      readRepo({ files: ['apps/api/src/index.js', 'Dockerfile'] }),
    );
    expect(byId(checks, 'repo-build-context').status).toBe('warn');
  });
});

describe('repo-port', () => {
  it('pass: deploy.port matches the evidenced port', () => {
    const checks = repoChecksFor(
      claims({ port: 8080 }),
      readRepo({ port: { value: 8080, source: 'Dockerfile:3 EXPOSE 8080' } }),
    );
    expect(byId(checks, 'repo-port').status).toBe('pass');
  });

  it('warn: the manifest and the repository disagree', () => {
    const checks = repoChecksFor(
      claims({ port: 3000 }),
      readRepo({ port: { value: 8080, source: 'Dockerfile:3 EXPOSE 8080' } }),
    );
    const c = byId(checks, 'repo-port');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('8080');
    expect(c.detail).toContain('3000');
  });

  it('unknown: no port evidence was found in the repository', () => {
    const checks = repoChecksFor(
      claims({ port: 3000 }),
      readRepo({ port: null }),
    );
    expect(byId(checks, 'repo-port').status).toBe('unknown');
  });
});

describe('repo-health-path', () => {
  const routes: RepoRoute[] = [{ path: '/status', source: 'src/routes.js:10' }];

  it('pass: the path matches a route the code serves', () => {
    const checks = repoChecksFor(
      claims({ healthPath: '/status' }),
      readRepo({ routes, routesEnumerable: true }),
    );
    expect(byId(checks, 'repo-health-path').status).toBe('pass');
  });

  it('warn: routes are enumerable, none are unresolved, and the path matches nothing', () => {
    const checks = repoChecksFor(
      claims({ healthPath: '/healthz' }),
      readRepo({ routes, routesEnumerable: true }),
    );
    const c = byId(checks, 'repo-health-path');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('/healthz');
  });

  it('unknown: a route is mounted under an unresolved prefix — the directus case', () => {
    // /health is declared in a router mounted on /server, whose mount point
    // this reader could not locate: the real served path may be /server/health,
    // not /health, so even an apparent match must never confirm.
    const directusRoutes: RepoRoute[] = [
      { path: '/health', source: 'server/routes.js:4', prefixUnresolved: true },
    ];
    const checks = repoChecksFor(
      claims({ healthPath: '/health' }),
      readRepo({ routes: directusRoutes, routesEnumerable: true }),
    );
    expect(byId(checks, 'repo-health-path').status).toBe('unknown');
  });

  it("unknown: this stack's routes are not enumerable at all", () => {
    const checks = repoChecksFor(
      claims({ healthPath: '/status' }),
      readRepo({ routes: [], routesEnumerable: false }),
    );
    expect(byId(checks, 'repo-health-path').status).toBe('unknown');
  });

  // The defect the adversarial review of pezzo 5 found, and the reason it was
  // invisible to the self-consistency bench: cartographer wrote `/status` into
  // the rendered manifest and this check approved it, both from one reading of
  // `findRoutes`. angular-grimmory's SetupController is annotated
  // `@RequestMapping("/api/v1/setup")`, so `/status` is a fragment. cartographer
  // now marks it; here the answer must be `unknown` — never `pass`, and never
  // `fail`, because a fragment cannot contradict a manifest either.
  it('unknown: the very path the manifest names was read, under a mount this reader could not locate', () => {
    const truncated: RepoRoute[] = [
      {
        path: '/status',
        source: 'src/main/java/SetupController.java:26',
        prefixUnresolved: true,
      },
    ];
    const checks = repoChecksFor(
      claims({ healthPath: '/status' }),
      readRepo({ routes: truncated, routesEnumerable: true }),
    );
    const c = byId(checks, 'repo-health-path');
    expect(c.status).toBe('unknown');
    expect(c.detail).toContain('src/main/java/SetupController.java:26');
    expect(c.detail).not.toContain('a route the code serves');
  });

  // spring-boot-gradle-kotlin-spring: the manifest probes /actuator/health and no file registers
  // it — `spring-boot-starter-actuator` in message-dashboard/build.gradle.kts is what serves it.
  // The path is confirmed, and calling a dependency line "a route the code serves" would not be.
  it('pass: a path derived from a declared dependency is confirmed, and says so instead of claiming a registration', () => {
    const fromDependency: RepoRoute[] = [
      {
        path: '/actuator/health',
        source: 'message-dashboard/build.gradle.kts:16',
        fromDependency: true,
      },
    ];
    const checks = repoChecksFor(
      claims({ healthPath: '/actuator/health' }),
      readRepo({ routes: fromDependency, routesEnumerable: true }),
    );
    const c = byId(checks, 'repo-health-path');
    expect(c.status).toBe('pass');
    expect(c.detail).toContain('serves by default');
    expect(c.detail).toContain('message-dashboard/build.gradle.kts:16');
    expect(c.detail).not.toContain('a route the code serves');
  });
});

describe('repo-env', () => {
  it('pass: every key the code reads is declared or supplied', () => {
    const checks = repoChecksFor(
      claims({ declaredEnvKeys: ['DATABASE_URL'] }),
      readRepo({
        envKeysReadByCode: [{ value: 'DATABASE_URL', source: 'src/db.js:2' }],
      }),
    );
    expect(byId(checks, 'repo-env').status).toBe('pass');
  });

  it('warn: a key the code reads is not declared and not supplied', () => {
    const checks = repoChecksFor(
      claims({ declaredEnvKeys: [] }),
      readRepo({
        envKeysReadByCode: [
          { value: 'STRIPE_SECRET_KEY', source: 'src/billing.js:8' },
        ],
      }),
    );
    const c = byId(checks, 'repo-env');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('STRIPE_SECRET_KEY');
  });

  it('unknown: no environment reads were found in the code', () => {
    const checks = repoChecksFor(claims(), readRepo({ envKeysReadByCode: [] }));
    expect(byId(checks, 'repo-env').status).toBe('unknown');
  });

  it("pass: the key is read in a unit other than the one this manifest covers (sveltekit-svgl's api-routes shape)", () => {
    const units: RepoUnit[] = [
      { name: 'web', root: '', dockerfile: 'Dockerfile' },
      {
        name: 'api-routes',
        root: 'api-routes',
        dockerfile: 'api-routes/Dockerfile',
      },
    ];
    const checks = repoChecksFor(
      claims({ unitPath: null }),
      readRepo({
        units,
        envKeysReadByCode: [
          { value: 'SKIP_ENV_VALIDATION', source: 'api-routes/src/env.ts:15' },
        ],
      }),
    );
    expect(byId(checks, 'repo-env').status).toBe('pass');
  });

  it('warn: a key read inside the covered unit still warns even with other units present', () => {
    const units: RepoUnit[] = [
      { name: 'web', root: '', dockerfile: 'Dockerfile' },
      {
        name: 'api-routes',
        root: 'api-routes',
        dockerfile: 'api-routes/Dockerfile',
      },
    ];
    const checks = repoChecksFor(
      claims({ unitPath: null }),
      readRepo({
        units,
        envKeysReadByCode: [
          { value: 'STRIPE_SECRET_KEY', source: 'src/billing.js:8' },
        ],
      }),
    );
    const c = byId(checks, 'repo-env');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('STRIPE_SECRET_KEY');
  });
});

describe('repo-services', () => {
  const compose: RepoDeclaredService[] = [
    { kind: 'redis', name: 'cache', source: 'docker-compose.yml:9' },
  ];

  it('pass: the repository declares no services', () => {
    const checks = repoChecksFor(claims(), readRepo({ declaredServices: [] }));
    expect(byId(checks, 'repo-services').status).toBe('pass');
  });

  it('warn: a declared service is not provided or linked', () => {
    const checks = repoChecksFor(
      claims({ providedServiceKinds: [] }),
      readRepo({ declaredServices: compose }),
    );
    const c = byId(checks, 'repo-services');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('redis');
  });

  it('unknown: not every file was read, so a compose file could exist unseen', () => {
    const checks = repoChecksFor(
      claims(),
      readRepo({
        declaredServices: [],
        boundary: boundary({ contentComplete: false }),
      }),
    );
    expect(byId(checks, 'repo-services').status).toBe('unknown');
  });

  it("pass: the service is declared in a unit other than the one this manifest covers (sveltekit-svgl's api-routes shape)", () => {
    const units: RepoUnit[] = [
      { name: 'web', root: '', dockerfile: 'Dockerfile' },
      {
        name: 'api-routes',
        root: 'api-routes',
        dockerfile: 'api-routes/Dockerfile',
      },
    ];
    const checks = repoChecksFor(
      claims({ unitPath: null, providedServiceKinds: [] }),
      readRepo({
        units,
        declaredServices: [
          {
            kind: 'redis',
            name: 'redis',
            source: 'api-routes/package.json:21',
          },
        ],
      }),
    );
    expect(byId(checks, 'repo-services').status).toBe('pass');
  });

  it('warn: a service declared inside the covered unit still warns even with other units present', () => {
    const units: RepoUnit[] = [
      { name: 'web', root: '', dockerfile: 'Dockerfile' },
      {
        name: 'api-routes',
        root: 'api-routes',
        dockerfile: 'api-routes/Dockerfile',
      },
    ];
    const checks = repoChecksFor(
      claims({ unitPath: null, providedServiceKinds: [] }),
      readRepo({ units, declaredServices: compose }),
    );
    const c = byId(checks, 'repo-services');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('redis');
  });
});

describe('repo-units', () => {
  it('pass: one unit, and the manifest covers it', () => {
    const checks = repoChecksFor(
      claims({ unitPath: null }),
      readRepo({
        units: [{ name: 'app', root: '', dockerfile: 'Dockerfile' }],
      }),
    );
    expect(byId(checks, 'repo-units').status).toBe('pass');
  });

  it('warn: more than one unit, and this manifest covers only one', () => {
    const units: RepoUnit[] = [
      { name: 'api', root: 'apps/api', dockerfile: 'apps/api/Dockerfile' },
      {
        name: 'worker',
        root: 'apps/worker',
        dockerfile: 'apps/worker/Dockerfile',
      },
    ];
    const checks = repoChecksFor(
      claims({ unitPath: 'apps/api' }),
      readRepo({ units }),
    );
    const c = byId(checks, 'repo-units');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('apps/worker');
  });

  it('unknown: the listing was truncated, so units could not be determined', () => {
    const checks = repoChecksFor(
      claims(),
      readRepo({ boundary: boundary({ listingComplete: false }) }),
    );
    expect(byId(checks, 'repo-units').status).toBe('unknown');
  });
});

describe('repo-blockers', () => {
  const blocker: RepoBlocker = {
    code: 'docker-socket',
    summary: 'mounts /var/run/docker.sock',
    remedy: 'remove the mount, or build without Docker-in-Docker',
    source: 'docker-compose.yml:14',
  };

  it('pass: nothing in the repository asks for what the platform cannot give', () => {
    const checks = repoChecksFor(claims(), readRepo({ blockers: [] }));
    expect(byId(checks, 'repo-blockers').status).toBe('pass');
  });

  it('warn: the repository asks for the Docker socket', () => {
    const checks = repoChecksFor(claims(), readRepo({ blockers: [blocker] }));
    const c = byId(checks, 'repo-blockers');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('docker.sock');
    expect(c.status).not.toBe('fail');
  });

  it('unknown: not every file was read and no blocker was found yet', () => {
    const checks = repoChecksFor(
      claims(),
      readRepo({
        blockers: [],
        boundary: boundary({ contentComplete: false }),
      }),
    );
    expect(byId(checks, 'repo-blockers').status).toBe('unknown');
  });
});

describe('manifest-currency', () => {
  it('pass: nothing aged or inert', () => {
    const checks = allChecksFor(facts(), {
      claims: claims(),
      currency: shape(),
    });
    expect(byId(checks, 'manifest-currency').status).toBe('pass');
  });

  it('warn: a legacy apiVersion, a deprecated env list, inert fields, and auto strategy all surface', () => {
    const checks = allChecksFor(facts(), {
      claims: claims(),
      currency: shape({
        apiVersion: 'flui/v1',
        envForm: 'list',
        inertFields: ['resources.profile', 'scaling'],
        resolvedBuildStrategy: 'auto',
      }),
    });
    const c = byId(checks, 'manifest-currency');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('flui/v1');
    expect(c.detail).toContain('deploy.env');
    expect(c.detail).toContain('resources.profile');
    expect(c.detail).toContain('Railpack');
  });

  it('answers even with no repository connected — never unknown', () => {
    const checks = allChecksFor(
      facts({ repositoryConnected: null, repoFullName: null }),
      {
        claims: claims(),
        currency: shape({ apiVersion: 'flui/v1' }),
      },
    );
    const c = byId(checks, 'manifest-currency');
    expect(c.status).toBe('warn');
  });
});

describe('allChecksFor', () => {
  const self = (over: Partial<ManifestSelfFacts> = {}): ManifestSelfFacts => ({
    claims: claims(),
    currency: shape(),
    ...over,
  });

  it('with repo omitted, reproduces exactly the seven installation checks plus currency', () => {
    const withoutRepo = allChecksFor(facts(), self());
    expect(withoutRepo.map((c) => c.id)).toEqual([
      'cluster',
      'repository',
      'registry',
      'capacity',
      'placement',
      'identity',
      'exposure',
      'manifest-currency',
    ]);
    expect(withoutRepo.some((c) => c.id.startsWith('repo-'))).toBe(false);
  });

  it('with repo passed, appends the repository family between installation and currency', () => {
    const withRepo = allChecksFor(facts(), self(), readRepo());
    const ids = withRepo.map((c) => c.id);
    expect(ids).toContain('repo-snapshot');
    expect(ids).toContain('repo-dockerfile');
    expect(ids[ids.length - 1]).toBe('manifest-currency');
  });

  it('a repo read failure emits only repo-snapshot from the family, never a fail', () => {
    const unread: RepoFacts = {
      read: false,
      reason: 'too-large',
      repoFullName: 'acme/api',
      ref: 'main',
    };
    const withRepo = allChecksFor(facts(), self(), unread);
    const repoChecks = withRepo.filter((c) => c.id.startsWith('repo-'));
    expect(repoChecks).toHaveLength(1);
    expect(repoChecks[0].status).toBe('unknown');
    expect(withRepo.some((c) => c.status === 'fail')).toBe(false);
  });

  it('a demonstrable Dockerfile fail from the repository family still fails wouldDeploy-style checks', () => {
    const withRepo = allChecksFor(
      facts(),
      self({ claims: claims({ dockerfilePath: 'missing/Dockerfile' }) }),
      readRepo({
        files: ['src/index.js'],
        boundary: boundary({ listingComplete: true }),
      }),
    );
    expect(byId(withRepo, 'repo-dockerfile').status).toBe('fail');
  });
});

// Referenced only to keep the RepoDeclaredHealth import intentional and used
// in a positive-path assertion for repo-health-path via declaredHealth.
describe('repo-health-path via declared health', () => {
  it('pass: matches a Dockerfile HEALTHCHECK rather than a route', () => {
    const declaredHealth: RepoDeclaredHealth[] = [
      {
        path: '/status',
        kind: 'dockerfile',
        source: 'Dockerfile:9 HEALTHCHECK',
      },
    ];
    const checks = repoChecksFor(
      claims({ healthPath: '/status' }),
      readRepo({ declaredHealth, routes: [], routesEnumerable: false }),
    );
    expect(byId(checks, 'repo-health-path').status).toBe('pass');
  });
});
