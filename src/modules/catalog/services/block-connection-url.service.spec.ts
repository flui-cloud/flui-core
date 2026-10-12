jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { BlockConnectionUrlService } from './block-connection-url.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationEnvVar } from '../../applications/interfaces/source-config.interface';

const encryption = {
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => {
    if (!v.startsWith('enc:')) throw new Error('not encrypted');
    return v.slice(4);
  },
};

function harness() {
  const applicationsRepo = { update: jest.fn() };
  const kubernetes = { patchSecret: jest.fn() };
  const clusters = {
    findOne: jest.fn(async () => ({ kubeconfigEncrypted: 'enc:kube' })),
  };
  const svc = new BlockConnectionUrlService(
    applicationsRepo as never,
    encryption as never,
    kubernetes as never,
    clusters as never,
  );
  return { svc, applicationsRepo, kubernetes };
}

function block(over: Partial<ApplicationEntity> = {}): ApplicationEntity {
  return {
    id: 'pg-1',
    slug: 'postgresql-ab12',
    k8sNamespace: 'user-x',
    clusterId: 'c1',
    port: 5432,
    labels: { 'flui.cloud/db-engine': 'postgres' },
    env: [
      { name: 'POSTGRES_USER', value: 'app' },
      { name: 'POSTGRES_DB', value: 'appdb' },
      { name: 'POSTGRES_PASSWORD', value: 'enc:pw', secret: true },
    ],
    ...over,
  } as unknown as ApplicationEntity;
}

const valueOf = (env: ApplicationEnvVar[], name: string) =>
  env.find((e) => e.name === name)?.value;

const direct =
  'postgresql://app:pw@postgresql-ab12-svc.user-x.svc.cluster.local:5432/appdb';
const pooled =
  'postgresql://app:pw@postgresql-ab12-pooler.user-x.svc.cluster.local:5432/appdb';

describe('BlockConnectionUrlService and the two addresses', () => {
  it('gives an existing install the direct key and leaves its connection URL as it was', async () => {
    const { svc, kubernetes } = harness();
    const app = block({
      env: [
        ...block().env,
        {
          name: 'FLUI_CONNECTION_URL',
          value: 'enc:postgresql://kept',
          secret: true,
        },
      ] as ApplicationEnvVar[],
    });

    await svc.ensureOnExisting(app);

    expect(valueOf(app.env, 'FLUI_CONNECTION_URL')).toBe(
      'enc:postgresql://kept',
    );
    expect(valueOf(app.env, 'FLUI_DIRECT_URL')).toBe(`enc:${direct}`);
    expect(kubernetes.patchSecret).toHaveBeenCalledWith(
      'kube',
      'user-x',
      'postgresql-ab12-secret',
      { FLUI_DIRECT_URL: direct },
    );
  });

  it('writes both addresses on the direct host at generation, before the pooler proved ready', async () => {
    const { svc, kubernetes } = harness();
    const app = block({
      pooler: { enabled: true, routed: false } as ApplicationEntity['pooler'],
    });

    await svc.ensureAtGeneration(app, 'postgres', 5432);

    expect(valueOf(app.env, 'FLUI_CONNECTION_URL')).toBe(`enc:${direct}`);
    expect(valueOf(app.env, 'FLUI_DIRECT_URL')).toBe(`enc:${direct}`);
    expect(kubernetes.patchSecret).not.toHaveBeenCalled();
  });

  it('moves the connection URL onto the pooler and keeps the direct one on the database', async () => {
    const { svc, kubernetes, applicationsRepo } = harness();
    const app = block({
      pooler: { enabled: true, routed: true } as ApplicationEntity['pooler'],
      env: [
        ...block().env,
        { name: 'FLUI_CONNECTION_URL', value: `enc:${direct}`, secret: true },
        { name: 'FLUI_DIRECT_URL', value: `enc:${direct}`, secret: true },
      ] as ApplicationEnvVar[],
    });

    await svc.recompose(app);

    expect(valueOf(app.env, 'FLUI_CONNECTION_URL')).toBe(`enc:${pooled}`);
    expect(valueOf(app.env, 'FLUI_DIRECT_URL')).toBe(`enc:${direct}`);
    expect(applicationsRepo.update).toHaveBeenCalledWith('pg-1', {
      env: app.env,
    });
    expect(kubernetes.patchSecret).toHaveBeenCalledWith(
      'kube',
      'user-x',
      'postgresql-ab12-secret',
      { FLUI_CONNECTION_URL: pooled, FLUI_DIRECT_URL: direct },
    );
  });

  it('adds no direct key to an engine that is not PostgreSQL', async () => {
    const { svc } = harness();
    const app = block({
      labels: { 'flui.cloud/db-engine': 'redis' },
      env: [{ name: 'REDIS_PASSWORD', value: 'enc:pw', secret: true }],
    } as Partial<ApplicationEntity>);

    await svc.ensureAtGeneration(app, 'redis', 6379);

    expect(valueOf(app.env, 'FLUI_CONNECTION_URL')).toBeDefined();
    expect(valueOf(app.env, 'FLUI_DIRECT_URL')).toBeUndefined();
  });
});
