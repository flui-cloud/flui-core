import {
  applyEnvironmentProfile,
  normalizeManifestEnv,
  readServiceRef,
  serviceRefValue,
  resolveServiceRefAgainst,
  pickAppManifest,
  ServiceRefSibling,
} from './manifest-env.util';

describe('normalizeManifestEnv', () => {
  it('returns [] for an absent env block', () => {
    expect(normalizeManifestEnv(undefined)).toEqual([]);
    expect(normalizeManifestEnv(null)).toEqual([]);
  });

  it('passes the legacy list form through unchanged', () => {
    const list = [
      { name: 'NODE_ENV', value: 'production' },
      { name: 'DB', valueFrom: { secretRef: 'pg/PASSWORD' } },
    ];
    expect(normalizeManifestEnv(list)).toEqual(list);
  });

  it('expands a map with string shorthand into { name, value }', () => {
    expect(
      normalizeManifestEnv({
        NODE_ENV: 'production',
        API_URL: 'https://api.flui.cloud',
      }),
    ).toEqual([
      { name: 'NODE_ENV', value: 'production' },
      { name: 'API_URL', value: 'https://api.flui.cloud' },
    ]);
  });

  it('expands a map with object entries, preserving value/valueFrom/secret', () => {
    expect(
      normalizeManifestEnv({
        API_URL: { value: 'https://api.flui.cloud' },
        DB_PASSWORD: { valueFrom: { secretRef: 'pg/POSTGRES_PASSWORD' } },
        TOKEN: { value: 'x', secret: true },
      }),
    ).toEqual([
      { name: 'API_URL', value: 'https://api.flui.cloud' },
      { name: 'DB_PASSWORD', valueFrom: { secretRef: 'pg/POSTGRES_PASSWORD' } },
      { name: 'TOKEN', value: 'x', secret: true },
    ]);
  });

  it('lets the map key win over a name nested in the entry', () => {
    expect(
      normalizeManifestEnv({ REAL: { name: 'FAKE', value: 'v' } }),
    ).toEqual([{ name: 'REAL', value: 'v' }]);
  });

  it('carries planned fields through untouched (runtime ignores them)', () => {
    expect(
      normalizeManifestEnv({
        PUBLIC_ID: {
          value: 'abc',
          delivery: 'browser',
          description: 'analytics id',
        },
      }),
    ).toEqual([
      {
        name: 'PUBLIC_ID',
        value: 'abc',
        delivery: 'browser',
        description: 'analytics id',
      },
    ]);
  });

  it('drops a nonsensical scalar env block', () => {
    expect(normalizeManifestEnv('nope')).toEqual([]);
    expect(normalizeManifestEnv(42)).toEqual([]);
  });
});

describe('readServiceRef', () => {
  it('reads a service reference, defaulting key to url', () => {
    expect(
      readServiceRef({ name: 'API', valueFrom: { service: 'vops-api' } }),
    ).toEqual({ service: 'vops-api', key: 'url' });
  });

  it('honours an explicit key', () => {
    expect(
      readServiceRef({
        name: 'API_HOST',
        valueFrom: { service: 'api', key: 'host' },
      }),
    ).toEqual({ service: 'api', key: 'host' });
  });

  it('returns null for non-service entries', () => {
    expect(readServiceRef({ name: 'X', value: 'v' })).toBeNull();
    expect(
      readServiceRef({ name: 'X', valueFrom: { secretRef: 'pg/PW' } }),
    ).toBeNull();
    expect(
      readServiceRef({ name: 'X', valueFrom: { service: '' } }),
    ).toBeNull();
  });
});

describe('serviceRefValue', () => {
  const target = { slug: 'vops-api', namespace: 'user-dawit', port: 8080 };

  it('builds the in-cluster URL by default', () => {
    expect(serviceRefValue(target)).toBe(
      'http://vops-api-svc.user-dawit.svc.cluster.local:8080',
    );
  });

  it('returns the host or the port alone', () => {
    expect(serviceRefValue(target, 'host')).toBe(
      'vops-api-svc.user-dawit.svc.cluster.local',
    );
    expect(serviceRefValue(target, 'port')).toBe('8080');
  });

  it('omits the port when the sibling has none', () => {
    const noPort = { slug: 'web', namespace: 'user-dawit', port: null };
    expect(serviceRefValue(noPort)).toBe(
      'http://web-svc.user-dawit.svc.cluster.local',
    );
    expect(serviceRefValue(noPort, 'port')).toBe('');
  });
});

describe('resolveServiceRefAgainst', () => {
  const ref = { service: 'api', key: 'url' as const };
  const scope = { clusterId: 'c1', projectId: 'p1' };
  const sibling: ServiceRefSibling = {
    slug: 'api',
    namespace: 'user-dawit',
    port: 8080,
    clusterId: 'c1',
    projectId: 'p1',
  };

  it('resolves a live same-cluster same-project sibling', () => {
    expect(resolveServiceRefAgainst(ref, scope, sibling)).toEqual({
      value: 'http://api-svc.user-dawit.svc.cluster.local:8080',
    });
  });

  it('resolves when neither app is assigned to a project', () => {
    expect(
      resolveServiceRefAgainst(
        ref,
        { clusterId: 'c1' },
        { ...sibling, projectId: null },
      ).value,
    ).toContain('api-svc');
  });

  it('resolves when only one side has a project (constraint applies to both)', () => {
    expect(
      resolveServiceRefAgainst(ref, scope, { ...sibling, projectId: null })
        .value,
    ).toContain('api-svc');
  });

  it('skips a missing sibling as not-found', () => {
    expect(resolveServiceRefAgainst(ref, scope, null)).toEqual({
      value: null,
      reason: 'not-found',
    });
  });

  it('skips a soft-deleted sibling as not-found', () => {
    expect(
      resolveServiceRefAgainst(ref, scope, { ...sibling, deleted: true })
        .reason,
    ).toBe('not-found');
  });

  it('skips a sibling on another cluster', () => {
    expect(
      resolveServiceRefAgainst(ref, scope, { ...sibling, clusterId: 'c2' })
        .reason,
    ).toBe('cross-cluster');
  });

  it('skips a sibling in another project', () => {
    expect(
      resolveServiceRefAgainst(ref, scope, { ...sibling, projectId: 'p2' })
        .reason,
    ).toBe('cross-project');
  });

  it('honours the requested key', () => {
    expect(
      resolveServiceRefAgainst({ service: 'api', key: 'port' }, scope, sibling)
        .value,
    ).toBe('8080');
  });
});

describe('pickAppManifest', () => {
  const entry = (over: Partial<any> = {}) => ({
    valid: true,
    content: 'yaml',
    name: 'web',
    path: 'flui.yaml',
    ...over,
  });

  it('prefers an exact name match, even in a monorepo', () => {
    const chosen = pickAppManifest(
      [
        entry({ name: 'api', path: 'api/flui.yaml' }),
        entry({ name: 'web', path: 'web/flui.yaml' }),
      ],
      'web',
    );
    expect(chosen?.path).toBe('web/flui.yaml');
  });

  it('falls back to the subPath directory when no name matches', () => {
    const chosen = pickAppManifest(
      [
        entry({ name: 'x', path: 'api/flui.yaml' }),
        entry({ name: 'y', path: 'web/flui.yaml' }),
      ],
      'web',
      'web',
    );
    expect(chosen?.path).toBe('web/flui.yaml');
  });

  it('treats an undefined subPath as the repo root', () => {
    const chosen = pickAppManifest(
      [
        entry({ name: 'x', path: 'flui.yaml' }),
        entry({ name: 'y', path: 'api/flui.yaml' }),
      ],
      'web',
    );
    expect(chosen?.path).toBe('flui.yaml');
  });

  it('falls back to the sole manifest when there is exactly one', () => {
    const chosen = pickAppManifest([entry({ name: 'renamed' })], 'web');
    expect(chosen?.name).toBe('renamed');
  });

  it('returns null when nothing matches among several', () => {
    expect(
      pickAppManifest(
        [
          entry({ name: 'a', path: 'a/flui.yaml' }),
          entry({ name: 'b', path: 'b/flui.yaml' }),
        ],
        'web',
        'web',
      ),
    ).toBeNull();
  });

  it('ignores invalid or content-less candidates', () => {
    expect(
      pickAppManifest(
        [
          entry({ name: 'web', valid: false }),
          entry({ name: 'web', content: undefined }),
        ],
        'web',
      ),
    ).toBeNull();
  });
});

describe('applyEnvironmentProfile', () => {
  const base = () =>
    ({
      apiVersion: 'flui.cloud/v1beta1',
      kind: 'Application',
      metadata: { name: 'web' },
      deploy: {
        port: 80,
        env: { NODE_ENV: 'production', PUBLIC_ID: 'base' },
        resources: { requests: { cpu: '100m' } },
      },
      environments: {
        production: { branch: 'main', env: { PUBLIC_ID: 'prd' } },
        staging: {
          branch: 'develop',
          env: { PUBLIC_ID: 'stg' },
          deploy: { resources: { requests: { cpu: '50m' } } },
        },
      },
    }) as any;

  const envMap = (m: any) =>
    Object.fromEntries(
      normalizeManifestEnv(m.deploy.env).map((e) => [e.name, e.value]),
    );

  it('returns the manifest unchanged with no branch or no environments', () => {
    const m = base();
    expect(applyEnvironmentProfile(m, undefined)).toBe(m);
    const noEnvs = { ...base(), environments: undefined };
    expect(applyEnvironmentProfile(noEnvs, 'main')).toBe(noEnvs);
  });

  it('overlays the env of the profile bound to the branch, keeping other keys', () => {
    const out = applyEnvironmentProfile(base(), 'main');
    expect(envMap(out)).toEqual({ NODE_ENV: 'production', PUBLIC_ID: 'prd' });
  });

  it('binds a different branch to a different profile', () => {
    expect(envMap(applyEnvironmentProfile(base(), 'develop')).PUBLIC_ID).toBe(
      'stg',
    );
  });

  it('overrides whitelisted deploy fields (resources) per environment', () => {
    const out = applyEnvironmentProfile(base(), 'develop');
    expect(out.deploy.resources).toEqual({ requests: { cpu: '50m' } });
    // production has no deploy override → base resources kept
    expect(applyEnvironmentProfile(base(), 'main').deploy.resources).toEqual({
      requests: { cpu: '100m' },
    });
  });

  it('leaves the manifest unchanged when no profile matches the branch', () => {
    const m = base();
    expect(applyEnvironmentProfile(m, 'feature/x')).toBe(m);
  });

  it('replaces a base valueFrom key with the per-environment literal', () => {
    const m = {
      ...base(),
      deploy: {
        port: 80,
        env: { API_URL: { valueFrom: { service: 'api' } } },
      },
      environments: {
        prod: { branch: 'main', env: { API_URL: 'https://prod' } },
      },
    } as any;
    const out = applyEnvironmentProfile(m, 'main');
    expect(normalizeManifestEnv(out.deploy.env)).toEqual([
      { name: 'API_URL', value: 'https://prod' },
    ]);
  });

  it('never overrides build (artifact promotion is preserved)', () => {
    const m = {
      ...base(),
      build: { strategy: 'dockerfile', context: 'x' },
    } as any;
    expect(applyEnvironmentProfile(m, 'develop').build).toEqual({
      strategy: 'dockerfile',
      context: 'x',
    });
  });
});
