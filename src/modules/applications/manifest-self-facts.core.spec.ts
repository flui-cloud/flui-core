import type { ApplicationManifest } from '@flui-cloud/spec';
import { manifestClaims } from './manifest-self-facts.core';

/**
 * `deploy.services` is not in the installed spec type (see
 * `manifest-self-facts.core.ts`), so a manifest that carries it is built past
 * the type system here too — the same way ajv would have accepted it.
 */
function manifestWith(deploy: Record<string, unknown>): ApplicationManifest {
  return {
    kind: 'Application',
    apiVersion: 'flui.cloud/v1beta1',
    metadata: { name: 'app' },
    deploy: { port: 3000, ...deploy },
  } as unknown as ApplicationManifest;
}

describe('manifestClaims: deploy.services', () => {
  it('counts an attached service (block/name) as a provided service kind, exactly as express-realworld/flui.yaml declares it', () => {
    const manifest = manifestWith({
      services: [
        {
          name: 'db',
          block: 'postgresql',
          env: [{ name: 'DATABASE_URL', fromService: 'url' }],
        },
      ],
    });
    const claims = manifestClaims(manifest);
    expect(claims.providedServiceKinds).toEqual(
      expect.arrayContaining(['postgresql', 'postgres', 'db']),
    );
  });

  it('counts deploy.services[].env[].name (fromService) as a supplied env key, exactly as wger renders it', () => {
    const manifest = manifestWith({
      services: [
        {
          name: 'postgresql',
          block: 'postgresql',
          env: [{ name: 'PS_DATABASE_URI', fromService: 'url' }],
        },
      ],
    });
    const claims = manifestClaims(manifest);
    expect(claims.suppliedEnvKeys).toContain('PS_DATABASE_URI');
  });

  it('resolves the catalog block ref to its engine so a Postgres-family block matches a repository that detects `postgres`, exactly as flask-litestar-litestar-sqlalchemy-template declares it', () => {
    const manifest = manifestWith({
      services: [{ name: 'db', block: 'postgresql', env: [] }],
    });
    const claims = manifestClaims(manifest);
    expect(claims.providedServiceKinds).toContain('postgres');
  });

  it('does not claim an env key deploy.services never supplies', () => {
    const manifest = manifestWith({
      services: [{ name: 'db', block: 'postgresql', env: [] }],
    });
    const claims = manifestClaims(manifest);
    expect(claims.suppliedEnvKeys).not.toContain('DATABASE_URL');
  });

  it('is empty when the manifest attaches no services', () => {
    const manifest = manifestWith({});
    const claims = manifestClaims(manifest);
    expect(claims.providedServiceKinds).toEqual([]);
    expect(claims.suppliedEnvKeys).toEqual([]);
  });
});
