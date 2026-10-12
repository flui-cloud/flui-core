jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { ApplicationDeployProcessor } from './application-deploy.processor';

function processorWith(bringUp: jest.Mock) {
  const proc = Object.create(ApplicationDeployProcessor.prototype);
  proc.logger = { warn: jest.fn() };
  proc.moduleRef = { get: jest.fn(() => ({ bringUp })) };
  return proc;
}

describe('ApplicationDeployProcessor pooler refresh', () => {
  // A change to the pooler's lookup function must reach a database already
  // installed, not only new installs and restores.
  it('re-applies the pooler role on every deploy of a pooled database', async () => {
    const bringUp = jest.fn(async () => ({ routed: true, reason: null }));
    const proc = processorWith(bringUp);
    await proc.refreshPooler({
      id: 'db-1',
      slug: 'pg',
      pooler: { enabled: true },
    });
    expect(bringUp).toHaveBeenCalledWith('db-1');
  });

  it('leaves a database without a pooler alone and never fails the deploy', async () => {
    const bringUp = jest.fn(async () => {
      throw new Error('boom');
    });
    const proc = processorWith(bringUp);
    await proc.refreshPooler({ id: 'db-2', slug: 'pg', pooler: null });
    expect(bringUp).not.toHaveBeenCalled();
    await expect(
      proc.refreshPooler({ id: 'db-3', slug: 'pg', pooler: { enabled: true } }),
    ).resolves.toBeUndefined();
  });
});

describe('ApplicationDeployProcessor rollback of a pooled database', () => {
  it('restores the revision but keeps the connection URLs the pooler state composed', async () => {
    const proc = Object.create(ApplicationDeployProcessor.prototype);
    const update = jest.fn();
    proc.appRevisionsRepository = {
      findByApplicationIdAndRevisionNumber: jest.fn(async () => ({
        sourceConfigSnapshot: { image: 'postgres:17' },
        envSnapshot: [
          { name: 'POSTGRES_USER', value: 'old-user' },
          { name: 'FLUI_CONNECTION_URL', value: 'enc:direct', secret: true },
          { name: 'FLUI_DIRECT_URL', value: 'enc:direct', secret: true },
        ],
        resourcesSnapshot: null,
        replicas: 1,
        imageRef: 'postgres:17',
      })),
    };
    proc.applicationsRepository = {
      update,
      findById: jest.fn(async () => ({ id: 'db-1' })),
    };
    const app = {
      id: 'db-1',
      replicas: 1,
      pooler: { enabled: true, routed: true },
      env: [
        { name: 'POSTGRES_USER', value: 'new-user' },
        { name: 'FLUI_CONNECTION_URL', value: 'enc:pooled', secret: true },
        { name: 'FLUI_DIRECT_URL', value: 'enc:direct', secret: true },
      ],
    };

    await proc.restoreFromRevision(app, 3);

    expect(update.mock.calls[0][1].env).toEqual([
      { name: 'POSTGRES_USER', value: 'old-user' },
      { name: 'FLUI_CONNECTION_URL', value: 'enc:pooled', secret: true },
      { name: 'FLUI_DIRECT_URL', value: 'enc:direct', secret: true },
    ]);
  });
});

describe('ApplicationDeployProcessor pooler objects while forwarding', () => {
  const manifests = [
    { kind: 'Secret', name: 'pg-pooler' },
    { kind: 'Service', name: 'pg-pooler' },
    { kind: 'Service', name: 'pg-pooler-upstream' },
    { kind: 'EndpointSlice', name: 'pg-pooler-upstream-fwd' },
    { kind: 'Deployment', name: 'pg-pooler' },
  ].map((m) => ({
    ...m,
    yaml: `kind: ${m.kind}\nmetadata:\n  name: ${m.name}\n  namespace: p1\n`,
  }));

  async function applied(upstream: Record<string, unknown>) {
    const proc = Object.create(ApplicationDeployProcessor.prototype);
    proc.logger = { warn: jest.fn() };
    proc.manifestGenerator = { generatePooler: jest.fn(() => manifests) };
    const names: string[] = [];
    proc.kubernetesService = {
      applyManifest: jest.fn(async (_k: string, yaml: string) => {
        names.push(
          /name: (\S+)/.exec(yaml)![1] + ':' + /kind: (\S+)/.exec(yaml)![1],
        );
      }),
    };
    await proc.applyPooler(
      { slug: 'pg', k8sNamespace: 'p1', pooler: { enabled: true, upstream } },
      'kc',
    );
    return names;
  }

  it('leaves the upstream Service and its slice to the migration while the pooler forwards', async () => {
    expect(
      await applied({
        mode: 'forward',
        address: '10.250.0.2',
        port: 15432,
        linkId: 'l',
      }),
    ).toEqual([
      'pg-pooler:Secret',
      'pg-pooler:Service',
      'pg-pooler:Deployment',
    ]);
  });

  it('applies every pooler object when the pooler serves its own database', async () => {
    expect(await applied({ mode: 'local' })).toHaveLength(5);
  });
});
