jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { AppMigrationProcessor } from './app-migration.processor';
import {
  AppCutoverMode,
  AppMigrationStatus,
} from '../enums/app-migration.enum';

const SRC = 'cluster-src';
const DST = 'cluster-dst';

function setup(opts: { copyFails?: boolean } = {}) {
  const calls: string[] = [];
  const app: any = {
    id: 'app-1',
    slug: 'wiki',
    clusterId: SRC,
    replicas: 2,
    volumes: [{ name: 'data', mountPath: '/data' }],
  };
  const mig: any = {
    id: 'mig-1',
    srcAppId: app.id,
    srcClusterId: SRC,
    targetClusterId: DST,
    userId: 'user-1',
    cutoverMode: AppCutoverMode.AUTO,
    status: AppMigrationStatus.PENDING,
    provisionOverrides: {
      volumeDestinationId: 'dest-1',
      dedicatedNodeName: 'dst-worker-2',
    },
  };
  const migRepo = {
    findOne: jest.fn(async () => mig),
    save: jest.fn(async (m: any) => m),
  };
  const appRepo = {
    findOne: jest.fn(async () => app),
    save: jest.fn(async (a: any) => {
      calls.push(`rebind:${a.clusterId}:${a.dedicatedNodeName}`);
      return a;
    }),
  };
  const endpointRepo = {
    find: jest.fn(async () => [{ id: 'ep-1' }]),
    save: jest.fn(async (e: any) => e),
  };
  const opRepo = { update: jest.fn(), findOne: jest.fn(), save: jest.fn() };
  const materializer = {
    materializeOnCluster: jest.fn(async (_a: any, c: string, o: any) => {
      calls.push(`materialize:${c}:${o?.replicas}`);
    }),
    teardownOnCluster: jest.fn(async (_a: any, c: string) => {
      calls.push(`teardown:${c}`);
    }),
    scaleOnCluster: jest.fn(async (_a: any, c: string, n: number) => {
      calls.push(`scale:${c}:${n}`);
    }),
    waitStoppedOnCluster: jest.fn(async (_a: any, c: string) => {
      calls.push(`stopped:${c}`);
    }),
    waitReadyOnCluster: jest.fn(async (_a: any, c: string) => {
      calls.push(`ready:${c}`);
    }),
  };
  const endpoints = {
    reconcile: jest.fn(async () => {
      calls.push('dns');
    }),
  };
  const volumes = {
    warm: jest.fn(async () => {
      calls.push('warm');
    }),
    copy: jest.fn(async () => {
      calls.push('copy');
      if (opts.copyFails) throw new Error('bucket unreachable');
    }),
  };
  const processor = new AppMigrationProcessor(
    migRepo as any,
    opRepo as any,
    appRepo as any,
    endpointRepo as any,
    materializer as any,
    endpoints as any,
    volumes as any,
  );
  return { processor, calls, mig, app, volumes };
}

describe('moving an application with volumes', () => {
  it('stages the destination stopped, then stops the source, copies, starts the destination and only then moves DNS', async () => {
    const { processor, calls, mig, volumes } = setup();
    await processor.run({ data: { migrationId: mig.id } } as any);

    expect(calls).toEqual([
      `materialize:${DST}:0`,
      'warm',
      `scale:${SRC}:0`,
      `stopped:${SRC}`,
      'copy',
      `scale:${DST}:2`,
      `ready:${DST}`,
      'dns',
      `rebind:${DST}:dst-worker-2`,
    ]);
    expect(volumes.copy).toHaveBeenCalledWith(
      expect.anything(),
      { destinationId: 'dest-1', dedicatedNodeName: 'dst-worker-2' },
      'user-1',
      DST,
    );
    expect(mig.status).toBe(AppMigrationStatus.COMPLETED);
  });

  it('gives the source back its copies and leaves DNS alone when the copy fails', async () => {
    const { processor, calls, mig, app } = setup({ copyFails: true });
    await expect(
      processor.run({ data: { migrationId: mig.id } } as any),
    ).rejects.toThrow(/running on its original cluster again/);

    expect(calls).toContain(`scale:${DST}:0`);
    expect(calls[calls.length - 1]).toBe(`scale:${SRC}:2`);
    expect(calls).not.toContain('dns');
    expect(app.clusterId).toBe(SRC);
    expect(mig.status).toBe(AppMigrationStatus.FAILED);
  });

  it('parks a manual cutover with the source still serving', async () => {
    const { processor, calls, mig } = setup();
    mig.cutoverMode = AppCutoverMode.MANUAL;
    await processor.run({ data: { migrationId: mig.id } } as any);

    expect(calls).toEqual([`materialize:${DST}:0`, 'warm']);
    expect(mig.status).toBe(AppMigrationStatus.READY);
  });
});
