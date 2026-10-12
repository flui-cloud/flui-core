jest.mock('@kubernetes/client-node', () => ({}));

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DbSessionsService } from './db-sessions.service';

const POOLER_VIEW = {
  mode: 'transaction' as const,
  paused: false,
  upstream: 'local' as const,
  reason: null,
  pools: [],
  clients: [
    {
      pod: 'pg-pooler-1',
      id: 5,
      addr: '10.42.0.15',
      clientApp: { id: 'consumer-1', name: 'talk-api' },
      user: 'owner',
      database: 'appdb',
      state: 'active',
      waitMs: 0,
      serverPid: 12,
      applicationName: '',
      connectTime: '2026-10-12 07:00:00 UTC',
      canClose: true,
    },
  ],
};

const APP: Record<string, unknown> = {
  id: 'db-1',
  slug: 'postgresql-abc',
  clusterId: 'c-1',
  k8sNamespace: 'proj-a',
  labels: { 'flui.cloud/db-engine': 'postgres' },
  imageRef: 'ghcr.io/flui-cloud/flui-postgres:17',
  env: [
    { name: 'POSTGRES_USER', value: 'owner' },
    { name: 'POSTGRES_DB', value: 'appdb' },
  ],
};

const SNAPSHOT = {
  captured_at: '2026-10-12T07:00:01.5+00:00',
  max_connections: 100,
  counts: {
    total: 3,
    active: 1,
    idle: 1,
    idle_in_transaction: 1,
    waiting: 0,
    blocked: 1,
  },
  truncated: false,
  rows: [
    {
      pid: 11,
      backend_start: '2026-10-12T06:00:00.001+00:00',
      backend_type: 'client backend',
      state: 'idle in transaction',
      wait_event_type: 'Client',
      wait_event: 'ClientRead',
      usename: 'owner',
      datname: 'appdb',
      application_name: '',
      client_addr: '10.42.0.15',
      writing: true,
      query: "UPDATE t SET v = 'x'",
      blocked_by: [],
      xact_age_ms: 60000,
      query_age_ms: 59000,
      state_age_ms: 59000,
    },
    {
      pid: 12,
      backend_start: '2026-10-12T06:30:00.002+00:00',
      backend_type: 'client backend',
      state: 'active',
      wait_event_type: 'Lock',
      wait_event: 'transactionid',
      usename: 'owner',
      datname: 'appdb',
      application_name: 'psql',
      client_addr: '10.42.0.16',
      writing: false,
      query: 'UPDATE t SET v = 2',
      blocked_by: [11],
      xact_age_ms: 3000,
      query_age_ms: 3000,
      state_age_ms: 3000,
    },
  ],
};

function build(execOut: string | Error = JSON.stringify(SNAPSHOT)) {
  const execInPod = jest.fn(async (..._a: unknown[]) => {
    if (execOut instanceof Error) throw execOut;
    return execOut;
  });
  const emitSessionAction = jest.fn();
  const app = { ...APP };
  const applications = {
    findById: jest.fn(async () => app),
    findActiveByCluster: jest.fn(async () => [
      { id: 'consumer-1', name: 'talk-api', k8sNamespace: 'proj-a' },
      { id: 'other-ns', name: 'secret-app', k8sNamespace: 'proj-b' },
    ]),
  };
  const kubernetes = {
    execInPod,
    listPodsByLabel: jest.fn(async () => [
      {
        metadata: { labels: { 'flui-app-id': 'consumer-1' } },
        status: { podIP: '10.42.0.15' },
      },
      {
        metadata: { labels: { 'flui-app-id': 'other-ns' } },
        status: { podIP: '10.42.0.16' },
      },
    ]),
  };
  const pooler = {
    view: jest.fn(async (input: { pooler?: unknown }) =>
      input.pooler ? POOLER_VIEW : null,
    ),
    closeClient: jest.fn(async () => 'closed' as 'closed' | 'gone'),
  };
  const service = new DbSessionsService(
    applications as never,
    { getKubeconfig: jest.fn(async () => 'kc') } as never,
    kubernetes as never,
    { emitSessionAction } as never,
    pooler,
    { decrypt: (v: string) => v.replace(/^enc:/, '') } as never,
  );
  return { service, execInPod, emitSessionAction, app, pooler };
}

const decoded = (execInPod: jest.Mock): string => {
  const cmd = (execInPod.mock.calls[0] as unknown[])[4] as string[];
  const b64 = /echo (\S+) \|/.exec(cmd[2])?.[1] ?? '';
  return Buffer.from(b64, 'base64').toString('utf8');
};

describe('DbSessionsService', () => {
  it('reads sessions as the superuser over the pod socket', async () => {
    const { service, execInPod } = build();
    await service.list('db-1');
    const [kc, ns, selector, container, cmd] = execInPod.mock
      .calls[0] as unknown[];
    expect([kc, ns, selector, container]).toEqual([
      'kc',
      'proj-a',
      'flui-app-id=db-1',
      'postgresql-abc',
    ]);
    expect((cmd as string[])[2]).toContain(
      "gosu postgres psql -X -U 'owner' -d 'appdb'",
    );
    expect((cmd as string[])[2]).not.toContain('-h ');
  });

  it('decrypts a database user kept as a secret', async () => {
    const { service, execInPod, app } = build();
    app.env = [
      { name: 'POSTGRES_USER', value: 'enc:owner', secret: true },
      { name: 'POSTGRES_DB', value: 'appdb' },
    ];
    await service.list('db-1');
    expect(
      ((execInPod.mock.calls[0] as unknown[])[4] as string[])[2],
    ).toContain("psql -X -U 'owner' -d 'appdb'");
  });

  it('maps the snapshot, names apps only in the same namespace and masks queries', async () => {
    const { service } = build();
    const view = await service.list('db-1');
    expect(view).toMatchObject({
      engine: 'postgres',
      capturedAt: '2026-10-12T07:00:01.500Z',
      maxConnections: 100,
      total: 3,
      counts: { blocked: 1, idleInTransaction: 1 },
      pooler: null,
    });
    const [holder, waiter] = view.sessions;
    expect(holder).toMatchObject({
      pid: 11,
      blocks: 1,
      clientApp: { id: 'consumer-1', name: 'talk-api' },
      query: 'UPDATE t SET v = ?',
    });
    expect(waiter.clientApp).toBeNull();
    expect(waiter.blockedBy).toEqual([11]);
  });

  it('refuses an engine other than PostgreSQL', async () => {
    const { service, app } = build();
    app.labels = { 'flui.cloud/db-engine': 'mariadb' };
    await expect(service.list('db-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('says the pod is unreachable rather than failing silently', async () => {
    const { service } = build(new Error('No running pod found'));
    await expect(service.list('db-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('answers 409 when the pid no longer has that start time, and records it', async () => {
    const { service, execInPod, emitSessionAction } = build('\n');
    await expect(
      service.act('db-1', 12, '2026-10-12T06:30:00.002Z', 'terminate', 'u-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(decoded(execInPod)).toContain(
      "\\set started '2026-10-12T06:30:00.002Z'",
    );
    expect(emitSessionAction).toHaveBeenCalledWith({
      dbInstallId: 'db-1',
      userId: 'u-1',
      action: 'terminate',
      pid: 12,
      outcome: 'gone',
    });
  });

  it('cancels a statement and records the action without its text', async () => {
    const { service, execInPod, emitSessionAction } = build('t\n');
    const result = await service.act(
      'db-1',
      12,
      '2026-10-12T06:30:00.002Z',
      'cancel',
      'u-1',
    );
    expect(result).toMatchObject({ pid: 12, action: 'cancel' });
    expect(decoded(execInPod)).toContain('pg_cancel_backend(pid)');
    const event = emitSessionAction.mock.calls[0][0] as Record<string, unknown>;
    expect(event.outcome).toBe('signalled');
    expect(JSON.stringify(event)).not.toMatch(/UPDATE/);
  });

  it('refuses a malformed start time before reaching the pod', async () => {
    const { service, execInPod } = build('t\n');
    await expect(
      service.act('db-1', 12, "now'; select 1; --", 'cancel'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(execInPod).not.toHaveBeenCalled();
  });

  describe('with a pooler', () => {
    const POOLER = {
      enabled: true,
      mode: 'transaction',
      upstream: { mode: 'local' },
    };

    it('passes the pooler to the view and names who is behind a pooled session', async () => {
      const { service, app, pooler } = build();
      app.pooler = POOLER;
      const ctxSpy = jest
        .spyOn(service as never, 'context' as never)
        .mockResolvedValue({
          poolerAddrs: new Set(['10.42.0.16']),
          appByAddr: new Map(),
        } as never);
      const view = await service.list('db-1');
      expect(pooler.view).toHaveBeenCalledWith(
        expect.objectContaining({ appId: 'db-1', pooler: POOLER }),
      );
      const pooled = view.sessions.find((s) => s.pid === 12);
      expect(pooled).toMatchObject({
        kind: 'pooler',
        clientApp: { id: 'consumer-1', name: 'talk-api' },
      });
      expect(view.pooler?.clients).toHaveLength(1);
      ctxSpy.mockRestore();
    });

    it('closes a pooled client and records it', async () => {
      const { service, app, pooler, emitSessionAction } = build();
      app.pooler = POOLER;
      const ref = {
        pod: 'pg-pooler-1',
        clientId: 5,
        connectTime: '2026-10-12 07:00:00 UTC',
      };
      await expect(
        service.closePoolerClient('db-1', ref, 'u-1'),
      ).resolves.toMatchObject({ clientId: 5, pod: 'pg-pooler-1' });
      expect(pooler.closeClient).toHaveBeenCalledWith(
        expect.objectContaining({ appId: 'db-1', namespace: 'proj-a' }),
        ref,
      );
      expect(emitSessionAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'close_pooled_client',
          pid: 5,
          pod: 'pg-pooler-1',
          outcome: 'signalled',
        }),
      );
    });

    it('answers 409 when the client is no longer the one listed', async () => {
      const { service, app, pooler } = build();
      app.pooler = POOLER;
      pooler.closeClient.mockResolvedValueOnce('gone');
      await expect(
        service.closePoolerClient('db-1', {
          pod: 'p',
          clientId: 5,
          connectTime: 'x',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to close a pooled client on a database without a pooler', async () => {
      const { service, pooler } = build();
      await expect(
        service.closePoolerClient('db-1', {
          pod: 'p',
          clientId: 5,
          connectTime: 'x',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(pooler.closeClient).not.toHaveBeenCalled();
    });
  });
});
