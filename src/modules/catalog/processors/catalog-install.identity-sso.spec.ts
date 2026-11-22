jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { CatalogInstallProcessor } from './catalog-install.processor';

const spec = {
  type: 'composed',
  auth: {
    default: 'oidc',
    oidc: {
      redirectPaths: ['/oidc/callback'],
      envMapping: {
        issuerUrl: 'OIDC_URL',
        clientId: 'OIDC_ID',
        clientSecret: 'OIDC_SECRET',
      },
    },
  },
  components: [
    {
      name: 'web',
      image: { registry: 'docker.io', repository: 'x', tag: '1' },
    },
  ],
};

function build(identityInstallId: string | null) {
  const pool = {
    ensureProject: jest.fn(async () => 'p1'),
    createClient: jest.fn(async () => ({
      appId: 'a1',
      clientId: 'c1',
      clientSecret: 'shh',
    })),
    deleteClient: jest.fn(async () => undefined),
  };
  const updates: Array<Record<string, unknown>> = [];
  const self = Object.create(CatalogInstallProcessor.prototype);
  Object.assign(self, {
    logger: { log: jest.fn(), warn: jest.fn() },
    installRepo: {
      findById: async () => ({ resolvedFqdn: 'wiki.example.com' }),
      update: jest.fn(async () => undefined),
    },
    identityPools: {
      resolve: jest.fn(async () => ({
        pool,
        issuer: 'https://login.example.com',
      })),
    },
    oidcProvider: { findProjectByName: jest.fn(), createWebOidcApp: jest.fn() },
    applicationRepo: {
      findById: async () => ({ id: 'app-1', env: [] }),
      update: jest.fn(async (_id: string, data: Record<string, unknown>) => {
        updates.push(data);
      }),
    },
    encryptionService: { encrypt: (v: string) => `enc:${v}` },
    deployService: {
      triggerDeployWithImage: jest.fn(async () => ({ id: 'op' })),
    },
    waitForDeployOperation: jest.fn(async () => ({ ok: true })),
    buildImageRef: () => 'docker.io/x:1',
    deployConfig: {
      getCatalogInstallWaitTimeoutMs: () => 1,
      getCatalogInstallPollIntervalMs: () => 1,
    },
  });
  const install = {
    id: 'i1',
    slug: 'wiki-ab12',
    clusterId: 'c1',
    authMode: 'oidc',
    identityInstallId,
  };
  const run = () =>
    (
      self as {
        maybeWireComposedOidc(...args: unknown[]): Promise<unknown>;
      }
    ).maybeWireComposedOidc(
      install,
      spec,
      spec.components[0],
      'app-1',
      new Map([['web', 'app-1']]),
    );
  return { run, pool, self, updates };
}

describe('a catalog app signing its users in with a customer identity install', () => {
  it('makes its client on that install, never on Flui’s own identity provider', async () => {
    const { run, pool, self } = build('idp-1');
    await run();
    expect(pool.createClient).toHaveBeenCalledWith('p1', {
      name: 'wiki-ab12',
      redirectUris: ['https://wiki.example.com/oidc/callback'],
      postLogoutRedirectUris: ['https://wiki.example.com/'],
    });
    expect(
      (self as { oidcProvider: { createWebOidcApp: jest.Mock } }).oidcProvider
        .createWebOidcApp,
    ).not.toHaveBeenCalled();
  });

  it('hands the app the customer issuer and keeps the secret encrypted', async () => {
    const { run, updates } = build('idp-1');
    await run();
    expect(updates[0].env).toEqual([
      { name: 'OIDC_URL', value: 'https://login.example.com' },
      { name: 'OIDC_ID', value: 'c1' },
      { name: 'OIDC_SECRET', value: 'enc:shh', secret: true },
    ]);
  });
});
