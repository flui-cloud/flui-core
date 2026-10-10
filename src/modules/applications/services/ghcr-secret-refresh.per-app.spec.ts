jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import {
  GhcrSecretRefreshService,
  ghcrPullSecretName,
} from './ghcr-secret-refresh.service';
import { ApplicationEntity } from '../entities/application.entity';

describe('pull secrets in a shared project namespace', () => {
  const applied: string[] = [];
  const service = new GhcrSecretRefreshService(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    {
      applyManifest: async (_kc: string, manifest: string) => {
        applied.push(manifest);
      },
    } as never,
    undefined as never,
    undefined as never,
    { host: () => null } as never,
  );
  (
    service as unknown as {
      resolvePullCredentials: () => Promise<unknown>;
    }
  ).resolvePullCredentials = async () => ({
    username: 'someone',
    token: 't',
    source: 'pat',
  });

  const app = (slug: string, userId: string) =>
    ({
      id: slug,
      slug,
      userId,
      imageRef: `ghcr.io/acme/${slug}:1`,
      k8sNamespace: 'p-web-team',
    }) as unknown as ApplicationEntity;

  it('gives each application its own secret, so one owner never overwrites another', async () => {
    const a = await service.ensureSecretForApp('kc', app('api', 'u1'));
    const b = await service.ensureSecretForApp('kc', app('web', 'u2'));

    expect(a).toBe(ghcrPullSecretName('api'));
    expect(b).toBe(ghcrPullSecretName('web'));
    expect(a).not.toBe(b);
    expect(applied[0]).toContain(`name: ${a}`);
    expect(applied[1]).toContain(`name: ${b}`);
  });
});

describe('the periodic refresh of pull secrets', () => {
  const tokenIn = (manifest: string) => {
    const config = /\.dockerconfigjson: (\S+)/.exec(manifest)![1];
    const { auths } = JSON.parse(Buffer.from(config, 'base64').toString());
    return Buffer.from(auths['ghcr.io'].auth, 'base64').toString();
  };

  it('writes each person their own credential, even when their images share a GitHub owner', async () => {
    const applied: string[] = [];
    const apps = [
      { slug: 'shop', userId: 'u1', ns: 'p-one' },
      { slug: 'blog', userId: 'u2', ns: 'p-two' },
      { slug: 'docs', userId: 'u1', ns: 'p-one' },
    ].map(
      ({ slug, userId, ns }) =>
        ({
          id: slug,
          slug,
          userId,
          clusterId: 'c1',
          imageRef: `ghcr.io/acme/${slug}:1`,
          k8sNamespace: ns,
        }) as unknown as ApplicationEntity,
    );
    const service = new GhcrSecretRefreshService(
      {
        findOne: async () => ({ id: 'c1', kubeconfigEncrypted: 'x' }),
      } as never,
      undefined as never,
      { findActiveGitBuildApps: async () => apps } as never,
      { decrypt: () => 'kc' } as never,
      {
        applyManifest: async (_kc: string, manifest: string) => {
          applied.push(manifest);
        },
      } as never,
      undefined as never,
      undefined as never,
      { host: () => null } as never,
    );
    (
      service as unknown as {
        resolvePullCredentials: (userId: string) => Promise<unknown>;
      }
    ).resolvePullCredentials = async (userId: string) => ({
      username: userId,
      token: `token-of-${userId}`,
      source: 'pat',
    });

    await service.refreshAll();

    const bySecret = new Map(
      applied.map((m) => [/name: (\S+)/.exec(m)![1], tokenIn(m)]),
    );
    expect(bySecret.get(ghcrPullSecretName('shop'))).toBe('u1:token-of-u1');
    expect(bySecret.get(ghcrPullSecretName('docs'))).toBe('u1:token-of-u1');
    expect(bySecret.get(ghcrPullSecretName('blog'))).toBe('u2:token-of-u2');
  });
});

describe('pull secrets for images on the instance’s own registry', () => {
  const HOST = 'api.example.test';
  const auths = (manifest: string) => {
    const config = /\.dockerconfigjson: (\S+)/.exec(manifest)![1];
    return JSON.parse(Buffer.from(config, 'base64').toString()).auths;
  };
  const harness = () => {
    const applied: string[] = [];
    const issued: string[] = [];
    const service = new GhcrSecretRefreshService(
      {
        findOne: async () => ({ id: 'c1', kubeconfigEncrypted: 'x' }),
      } as never,
      undefined as never,
      {
        findActiveGitBuildApps: async () => [
          {
            id: 'a1',
            slug: 'shop',
            userId: 'u1',
            clusterId: 'c1',
            imageRef: `${HOST}/apps/a1:abc1234`,
            imageRegistryHost: HOST,
            k8sNamespace: 'p-one',
          },
        ],
      } as never,
      { decrypt: () => 'kc' } as never,
      {
        applyManifest: async (_kc: string, manifest: string) => {
          applied.push(manifest);
        },
      } as never,
      undefined as never,
      undefined as never,
      {
        host: () => HOST,
        issuePullCredential: async (appId: string) => {
          issued.push(appId);
          return { username: `pull-${appId}`, password: 'secret' };
        },
      } as never,
    );
    return { service, applied, issued };
  };

  it('pulls with the application’s own read-only credential, never a GitHub token', async () => {
    const { service, applied, issued } = harness();
    const name = await service.ensureSecretForApp('kc', {
      id: 'a1',
      slug: 'shop',
      userId: 'u1',
      imageRef: `${HOST}/apps/a1:abc1234`,
      imageRegistryHost: HOST,
      k8sNamespace: 'p-one',
    } as unknown as ApplicationEntity);

    expect(name).toBe(ghcrPullSecretName('shop'));
    expect(issued).toEqual(['a1']);
    const entry = auths(applied[0]);
    expect(Object.keys(entry)).toEqual([HOST]);
    expect(Buffer.from(entry[HOST].auth, 'base64').toString()).toBe(
      'pull-a1:secret',
    );
  });

  it('leaves them out of the periodic GHCR refresh, since they do not expire', async () => {
    const { service, applied, issued } = harness();
    await service.refreshAll();
    expect(applied).toEqual([]);
    expect(issued).toEqual([]);
  });
});
