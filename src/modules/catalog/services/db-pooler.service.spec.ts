jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { Readable } from 'node:stream';
import { DbPoolerService } from './db-pooler.service';
import { PoolerSpec } from '../../applications/utils/db-pooler.core';

const encryption = {
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
};

const spec: PoolerSpec = {
  enabled: true,
  mode: 'transaction',
  replicas: 1,
  image: 'ghcr.io/cloudnative-pg/pgbouncer:1.26.0',
  authPasswordEnc: 'enc:a1b2c3',
  adminPasswordEnc: 'enc:d4e5f6',
  upstream: { mode: 'local' },
  routed: false,
  enabledAt: '2026-10-12T00:00:00.000Z',
};

function harness(over: { waitFails?: boolean; standby?: boolean } = {}) {
  const app = {
    id: 'db-1',
    slug: 'postgresql-ab12',
    k8sNamespace: 'user-x',
    clusterId: 'c1',
    port: 5432,
    env: [
      { name: 'POSTGRES_USER', value: 'postgresql-ab12' },
      { name: 'POSTGRES_DB', value: 'postgresql-ab12' },
      ...(over.standby ? [{ name: 'FLUI_PG_STANDBY', value: '1' }] : []),
    ],
    pooler: { ...spec },
  };
  const applications = {
    findById: jest.fn(async () => app),
    update: jest.fn(),
  };
  const stdin: string[] = [];
  const kubernetes = {
    execStream: jest.fn(
      async (
        _kc: string,
        _ns: string,
        _sel: string,
        _cmd: string[],
        streams: { stdin: Readable },
      ) => {
        for await (const chunk of streams.stdin) stdin.push(String(chunk));
      },
    ),
    waitForReady: jest.fn(async () => {
      if (over.waitFails) throw new Error('timed out');
      return true;
    }),
    getResource: jest.fn(async () => ({ spec: { clusterIP: '10.43.7.9' } })),
    applyManifest: jest.fn(async () => []),
    listPodsByLabel: jest.fn(async () => [
      {
        metadata: { name: 'postgresql-ab12-pooler-x' },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
    ]),
  };
  const connectionUrl = {
    recompose: jest.fn(async (_app: { pooler: PoolerSpec }) => undefined),
  };
  const svc = new DbPoolerService(
    applications as never,
    {
      findOne: jest.fn(async () => ({ kubeconfigEncrypted: 'enc:kube' })),
    } as never,
    kubernetes as never,
    encryption as never,
    { generate: () => 'f00d' } as never,
    connectionUrl as never,
    {
      generatePooler: jest.fn(() => [
        {
          kind: 'Secret',
          name: 'p',
          yaml: 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: p\n  namespace: user-x\n',
        },
        { kind: 'EndpointSlice', name: 'f', yaml: 'kind: EndpointSlice' },
      ]),
    } as never,
  );
  return { svc, app, applications, kubernetes, connectionUrl, stdin };
}

describe('DbPoolerService.bringUp', () => {
  it('sets the role up on the database pod with the password on stdin, waits, then routes the URL', async () => {
    const { svc, kubernetes, connectionUrl, applications, stdin } = harness();

    expect(await svc.bringUp('db-1')).toEqual({ routed: true, reason: null });

    const [, ns, selector, command, , container] = kubernetes.execStream.mock
      .calls[0] as unknown as [
      string,
      string,
      string,
      string[],
      unknown,
      string,
    ];
    expect([ns, selector, container]).toEqual([
      'user-x',
      'flui-app-id=db-1',
      'postgresql-ab12',
    ]);
    expect(command.join(' ')).not.toContain('a1b2c3');
    expect(stdin.join('')).toContain("\\set pw 'SCRAM-SHA-256$4096:");
    expect(stdin.join('')).not.toContain('a1b2c3');
    expect(kubernetes.waitForReady).toHaveBeenCalledWith(
      'kube',
      'Deployment',
      'postgresql-ab12-pooler',
      'user-x',
      expect.any(Number),
    );
    const recomposed = connectionUrl.recompose.mock.calls[0][0];
    expect(recomposed.pooler.routed).toBe(true);
    expect(applications.update).toHaveBeenCalledWith('db-1', {
      pooler: expect.objectContaining({
        routed: true,
        lastError: null,
        upstreamClusterIP: '10.43.7.9',
      }),
    });
  });

  it('keeps the URL direct and records why when a new pooler never becomes ready', async () => {
    const { svc, connectionUrl, applications } = harness({ waitFails: true });

    const result = await svc.bringUp('db-1');

    expect(result.routed).toBe(false);
    expect(result.reason).toMatch(
      /connect to the database directly: timed out/,
    );
    expect(connectionUrl.recompose).toHaveBeenCalledTimes(1);
    expect(connectionUrl.recompose.mock.calls[0][0].pooler.routed).toBe(false);
    expect(applications.update).toHaveBeenCalledWith('db-1', {
      pooler: expect.objectContaining({
        routed: false,
        lastError: result.reason,
      }),
    });
  });

  it('keeps a routed pooler routed when a refresh fails, and records why', async () => {
    const { svc, app, connectionUrl, applications } = harness({
      waitFails: true,
    });
    app.pooler = { ...spec, routed: true, upstreamClusterIP: '10.43.7.9' };

    const result = await svc.bringUp('db-1');

    expect(result.routed).toBe(true);
    expect(result.reason).toMatch(/still connect through it: timed out/);
    expect(connectionUrl.recompose).not.toHaveBeenCalled();
    expect(applications.update).toHaveBeenCalledTimes(1);
    expect(applications.update).toHaveBeenCalledWith('db-1', {
      pooler: expect.objectContaining({
        routed: true,
        lastError: result.reason,
        upstreamClusterIP: '10.43.7.9',
      }),
    });
  });

  it('does nothing for a database without a pooler', async () => {
    const { svc, app, kubernetes } = harness();
    (app as { pooler: unknown }).pooler = null;
    expect(await svc.bringUp('db-1')).toEqual({ routed: false, reason: null });
    expect(kubernetes.execStream).not.toHaveBeenCalled();
  });
});

describe('DbPoolerService.status', () => {
  it('names both addresses and the pods of the pooler', async () => {
    const { svc, app } = harness();
    app.pooler = { ...spec, routed: true };
    expect(await svc.status('db-1')).toEqual({
      enabled: true,
      mode: 'transaction',
      replicas: 1,
      image: spec.image,
      upstream: 'local',
      routed: true,
      reason: null,
      addresses: {
        pooled: 'postgresql-ab12-pooler.user-x.svc.cluster.local:5432',
        direct: 'postgresql-ab12-svc.user-x.svc.cluster.local:5432',
      },
      pods: [{ name: 'postgresql-ab12-pooler-x', ready: true }],
    });
  });

  it('says plainly when there is no pooler', async () => {
    const { svc, app } = harness();
    (app as { pooler: unknown }).pooler = null;
    const status = await svc.status('db-1');
    expect(status.enabled).toBe(false);
    expect(status.addresses).toEqual({
      pooled: null,
      direct: 'postgresql-ab12-svc.user-x.svc.cluster.local:5432',
    });
  });
});

describe('DbPoolerService.newSpec', () => {
  it('pins the image and keeps both passwords encrypted, not routed yet', () => {
    const { svc } = harness();
    const fresh = svc.newSpec('session', new Date('2026-10-12T00:00:00Z'));
    expect(fresh).toMatchObject({
      enabled: true,
      mode: 'session',
      replicas: 1,
      authPasswordEnc: 'enc:f00d',
      adminPasswordEnc: 'enc:f00d',
      upstream: { mode: 'local' },
      routed: false,
    });
    expect(fresh.image).toMatch(/pgbouncer/);
  });
});

describe('DbPoolerService around a migration', () => {
  it('leaves a standby alone: its role and routing come from the source', async () => {
    const { svc, kubernetes, applications, connectionUrl } = harness({
      standby: true,
    });
    expect(await svc.bringUp('db-1')).toEqual({ routed: false, reason: null });
    expect(kubernetes.execStream).not.toHaveBeenCalled();
    expect(applications.update).not.toHaveBeenCalled();
    expect(connectionUrl.recompose).not.toHaveBeenCalled();
  });

  it('applies the pooler objects now and waits for the pooler to roll', async () => {
    const { svc, kubernetes } = harness();
    await svc.applyObjects('db-1');
    expect(kubernetes.applyManifest).toHaveBeenCalledTimes(2);
    expect(kubernetes.waitForReady).toHaveBeenCalledWith(
      'kube',
      'Deployment',
      'postgresql-ab12-pooler',
      'user-x',
      expect.any(Number),
    );
  });
});
