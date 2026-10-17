jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));
jest.mock('../../common/leadership/advisory-lock', () =>
  jest.requireActual('../../common/leadership/testing/fake-advisory-locks'),
);

import { AppMigrationProcessor } from './app-migration.processor';
import {
  AppCutoverMode,
  AppMigrationStatus,
} from '../enums/app-migration.enum';

function setup(opts: { volumes: boolean; dnsStuck?: boolean }) {
  const app: any = {
    id: 'app-1',
    slug: 'wiki',
    clusterId: 'src',
    replicas: 1,
    volumes: opts.volumes ? [{ name: 'data', mountPath: '/data' }] : [],
  };
  const mig: any = {
    id: 'mig-1',
    srcAppId: app.id,
    srcClusterId: 'src',
    targetClusterId: 'dst',
    userId: 'user-1',
    cutoverMode: AppCutoverMode.AUTO,
    status: AppMigrationStatus.PENDING,
    provisionOverrides: opts.volumes ? { volumeDestinationId: 'dest-1' } : {},
  };
  const materializer = {
    materializeOnCluster: jest.fn(async () => undefined),
    scaleOnCluster: jest.fn(async () => undefined),
    waitStoppedOnCluster: jest.fn(async () => undefined),
    waitReadyOnCluster: jest.fn(async () => undefined),
  };
  const processor = new AppMigrationProcessor(
    {
      manager: {},
      findOne: jest.fn(async () => mig),
      save: jest.fn(async (m: any) => m),
    } as any,
    { update: jest.fn(), findOne: jest.fn(), save: jest.fn() } as any,
    {
      findOne: jest.fn(async () => app),
      save: jest.fn(async (a: any) => a),
    } as any,
    {
      find: jest.fn(async () => [{ id: 'ep-1', fqdn: 'wiki.example.com' }]),
      update: jest.fn(async () => undefined),
    } as any,
    materializer as any,
    {
      reconcile: jest.fn(async () => !opts.dnsStuck),
      publishedAnswer: jest.fn(async () => null),
    } as any,
    {
      warm: jest.fn(async () => undefined),
      copy: jest.fn(async () => new Promise((r) => setTimeout(r, 30))),
    } as any,
    { findOne: jest.fn(async () => null) } as any,
    {} as any,
  );
  processor.reconcileAttempts = 1;
  processor.retryDelayMs = 0;
  return { processor, mig };
}

describe('AppMigrationProcessor measures', () => {
  it('records how long the application was stopped while its volumes moved, and when DNS moved', async () => {
    const { processor, mig } = setup({ volumes: true });
    await processor.run({ data: { migrationId: mig.id } } as any);

    expect(mig.status).toBe(AppMigrationStatus.COMPLETED);
    expect(mig.interruptionMs).toBeGreaterThanOrEqual(25);
    expect(mig.dnsFlippedAt).toBeInstanceOf(Date);
  });

  it('records no interruption for an application without volumes', async () => {
    const { processor, mig } = setup({ volumes: false });
    await processor.run({ data: { migrationId: mig.id } } as any);

    expect(mig.interruptionMs).toBeUndefined();
    expect(mig.dnsFlippedAt).toBeInstanceOf(Date);
  });

  it('records no DNS switch time when DNS did not move', async () => {
    const { processor, mig } = setup({ volumes: false, dnsStuck: true });
    await processor.run({ data: { migrationId: mig.id } } as any);

    expect(mig.status).toBe(AppMigrationStatus.COMPLETED);
    expect(mig.dnsFlippedAt).toBeUndefined();
  });
});
