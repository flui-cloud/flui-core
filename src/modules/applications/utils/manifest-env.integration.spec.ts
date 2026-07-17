import { validateApplicationManifest } from './application-manifest.util';
import {
  applyEnvironmentProfile,
  normalizeManifestEnv,
  readServiceRef,
  resolveServiceRefAgainst,
  ServiceRefSibling,
} from './manifest-env.util';
import { mergeAppEnv, collectEnvShadows } from './env-merge.util';
import { ApplicationEnvVar } from '../interfaces/source-config.interface';

/**
 * End-to-end over the real `@flui-cloud/spec` 0.8.0 schema: the map form and
 * `build.args` were rejected by ajv under 0.7.0 and never reached the runtime.
 * These prove they now survive validation and flow through the deploy env path.
 */

/** Mirror of the service's private `manifestEnvVar` for the plain/secretRef cases. */
const toEnvVar = (e: {
  name: string;
  value?: string;
  valueFrom?: { secretRef?: string };
}): ApplicationEnvVar | null => {
  const ref = e.valueFrom?.secretRef;
  if (ref) {
    const slash = ref.lastIndexOf('/');
    return {
      name: e.name,
      value: '',
      source: 'manifest',
      externalSecretRef: {
        secretName: ref.slice(0, slash),
        key: ref.slice(slash + 1),
      },
    };
  }
  if (e.value === undefined) return null;
  return { name: e.name, value: e.value, source: 'manifest' };
};

const manifestEnv = (raw: string): ApplicationEnvVar[] => {
  const { manifest } = validateApplicationManifest(raw);
  return normalizeManifestEnv(manifest.deploy.env)
    .map(toEnvVar)
    .filter((e): e is ApplicationEnvVar => e !== null);
};

describe('manifest env — 0.8.0 schema end-to-end', () => {
  it('accepts the map form and turns it into deploy env vars', () => {
    const env = manifestEnv(`
apiVersion: flui.cloud/v1beta1
kind: Application
metadata:
  name: vops-web
build:
  strategy: dockerfile
deploy:
  port: 80
  env:
    NODE_ENV: production
    API_URL: https://vops-api.flui.cloud
    DB_PASSWORD:
      valueFrom:
        secretRef: pg-secret/POSTGRES_PASSWORD
`);
    expect(env).toEqual([
      { name: 'NODE_ENV', value: 'production', source: 'manifest' },
      {
        name: 'API_URL',
        value: 'https://vops-api.flui.cloud',
        source: 'manifest',
      },
      {
        name: 'DB_PASSWORD',
        value: '',
        source: 'manifest',
        externalSecretRef: {
          secretName: 'pg-secret',
          key: 'POSTGRES_PASSWORD',
        },
      },
    ]);
  });

  it('accepts build.args (rejected under 0.7.0)', () => {
    expect(() =>
      validateApplicationManifest(`
apiVersion: flui.cloud/v1beta1
kind: Application
metadata:
  name: with-build-args
build:
  strategy: dockerfile
  args:
    NEXT_PUBLIC_API: https://api.flui.cloud
deploy:
  port: 3000
`),
    ).not.toThrow();
  });

  it('still accepts the legacy list form and warns it is deprecated', () => {
    const { warnings } = validateApplicationManifest(`
apiVersion: flui.cloud/v1beta1
kind: Application
metadata:
  name: legacy
build:
  strategy: dockerfile
deploy:
  port: 3000
  env:
    - name: NODE_ENV
      value: production
`);
    expect(warnings.some((w) => /deprecat/i.test(w.message))).toBe(true);
  });

  it('reclaims a pinned user key from the map manifest (the vops API_URL fix)', () => {
    const existing: ApplicationEnvVar[] = [
      {
        name: 'API_URL',
        value: 'http://vops-api-esaujr.89-167-42-194.nip.io',
        source: 'user',
      },
    ];
    const declared = manifestEnv(`
apiVersion: flui.cloud/v1beta1
kind: Application
metadata:
  name: vops-web
build:
  strategy: dockerfile
deploy:
  port: 80
  env:
    API_URL: https://vops-api.flui.cloud
`);

    const shadows = collectEnvShadows(existing, declared);
    expect(shadows).toEqual([
      {
        name: 'API_URL',
        previous: 'http://vops-api-esaujr.89-167-42-194.nip.io',
        manifest: 'https://vops-api.flui.cloud',
      },
    ]);

    const merged = mergeAppEnv(existing, declared);
    expect(merged.find((e) => e.name === 'API_URL')).toEqual({
      name: 'API_URL',
      value: 'https://vops-api.flui.cloud',
      source: 'manifest',
    });
  });

  it('accepts valueFrom.service and resolves it to the sibling in-cluster URL', () => {
    const { manifest } = validateApplicationManifest(`
apiVersion: flui.cloud/v1beta1
kind: Application
metadata:
  name: vops-web
build:
  strategy: dockerfile
deploy:
  port: 80
  env:
    API_URL:
      valueFrom:
        service: vops-api
        key: url
`);
    const entry = normalizeManifestEnv(manifest.deploy.env)[0];
    const ref = readServiceRef(entry);
    expect(ref).toEqual({ service: 'vops-api', key: 'url' });

    const sibling: ServiceRefSibling = {
      slug: 'vops-api',
      namespace: 'user-dawit',
      port: 8080,
      clusterId: 'c1',
      projectId: 'p1',
    };
    expect(
      resolveServiceRefAgainst(
        ref,
        { clusterId: 'c1', projectId: 'p1' },
        sibling,
      ),
    ).toEqual({
      value: 'http://vops-api-svc.user-dawit.svc.cluster.local:8080',
    });
  });

  it('validates and applies an environments block bound to a branch', () => {
    const { manifest } = validateApplicationManifest(`
apiVersion: flui.cloud/v1beta1
kind: Application
metadata:
  name: web
build:
  strategy: dockerfile
deploy:
  port: 80
  env:
    PUBLIC_UMAMI_WEBSITE_ID: base-id
environments:
  production:
    branch: main
    env:
      PUBLIC_UMAMI_WEBSITE_ID: prod-id
  staging:
    branch: develop
    env:
      PUBLIC_UMAMI_WEBSITE_ID: staging-id
`);

    const onMain = normalizeManifestEnv(
      applyEnvironmentProfile(manifest, 'main').deploy.env,
    );
    expect(onMain).toEqual([
      { name: 'PUBLIC_UMAMI_WEBSITE_ID', value: 'prod-id' },
    ]);

    const onDevelop = normalizeManifestEnv(
      applyEnvironmentProfile(manifest, 'develop').deploy.env,
    );
    expect(onDevelop[0].value).toBe('staging-id');

    // a branch bound to no environment keeps the base value
    const onFeature = normalizeManifestEnv(
      applyEnvironmentProfile(manifest, 'feature/x').deploy.env,
    );
    expect(onFeature[0].value).toBe('base-id');
  });
});
