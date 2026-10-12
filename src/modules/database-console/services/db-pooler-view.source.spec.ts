jest.mock('@kubernetes/client-node', () => ({}));

import { PgbouncerAdminViewSource } from './db-pooler-view.source';

const SHOW = [
  '@@ POOLS',
  'database|user|cl_active|cl_waiting|sv_active|sv_idle|maxwait|maxwait_us',
  'app|app|2|0|1|1|0|0',
  '@@ CLIENTS',
  'type|user|database|state|addr|port|connect_time|wait|wait_us|ptr|link|application_name|id',
  'C|app|app|active|10.42.0.15|5000|2026-10-12 07:00:00 UTC|0|0|0x1|0x9|talk|5',
  '@@ SERVERS',
  'type|user|database|state|addr|port|ptr|link|remote_pid|id',
  'S|app|app|active|10.42.0.10|5432|0x9|0x1|4242|3',
  '@@ DATABASES',
  'name|paused',
  'app|0',
  '',
].join('\n');

const SPEC = {
  enabled: true,
  mode: 'transaction' as const,
  replicas: 1,
  image: 'img',
  authPasswordEnc: 'a',
  adminPasswordEnc: 'b',
  upstream: { mode: 'local' as const },
  enabledAt: '2026-10-12T00:00:00Z',
};

function build(execOut: string | Error = SHOW) {
  const execInPod = jest.fn(async (..._a: unknown[]) => {
    if (execOut instanceof Error) throw execOut;
    return execOut;
  });
  const listPodsByLabel = jest.fn(async () => [
    { metadata: { name: 'pg-pooler-1' }, status: { phase: 'Running' } },
    { metadata: { name: 'pg-pooler-old' }, status: { phase: 'Pending' } },
  ]);
  const source = new PgbouncerAdminViewSource({
    execInPod,
    listPodsByLabel,
  } as never);
  const input = {
    appId: 'db-1',
    namespace: 'proj-a',
    kubeconfig: 'kc',
    pooler: SPEC,
    appByAddr: new Map([['10.42.0.15', { id: 'a-1', name: 'talk-api' }]]),
  };
  return { source, execInPod, listPodsByLabel, input };
}

describe('PgbouncerAdminViewSource', () => {
  it('reads nothing for a database without a pooler', async () => {
    const { source, input, listPodsByLabel } = build();
    await expect(source.view({ ...input, pooler: null })).resolves.toBeNull();
    await expect(
      source.view({ ...input, pooler: { ...SPEC, enabled: false } }),
    ).resolves.toBeNull();
    expect(listPodsByLabel).not.toHaveBeenCalled();
  });

  it('asks every running pooler pod by name, in its pgbouncer container', async () => {
    const { source, input, execInPod, listPodsByLabel } = build();
    const view = await source.view(input);
    expect(listPodsByLabel).toHaveBeenCalledWith(
      'kc',
      'proj-a',
      'flui.cloud/pooler-of=db-1',
    );
    expect(execInPod).toHaveBeenCalledTimes(1);
    const call = execInPod.mock.calls[0];
    expect(call[3]).toBe('pgbouncer');
    expect(call[5]).toBe('pg-pooler-1');
    expect(view).toMatchObject({
      mode: 'transaction',
      upstream: 'local',
      paused: false,
      reason: null,
      pools: [{ pod: 'pg-pooler-1', clientsActive: 2 }],
      clients: [
        {
          id: 5,
          serverPid: 4242,
          clientApp: { id: 'a-1', name: 'talk-api' },
        },
      ],
    });
  });

  it('says why when the pooler cannot be read, instead of hiding it', async () => {
    const { source, input } = build(new Error('connection refused'));
    const view = await source.view(input);
    expect(view?.reason).toContain('connection refused');
    expect(view?.pools).toEqual([]);
  });

  it('closes a client only while its id and connect time still match', async () => {
    const { source, input, execInPod } = build();
    await expect(
      source.closeClient(input, {
        pod: 'pg-pooler-1',
        clientId: 5,
        connectTime: '2026-10-12 07:00:01 UTC',
      }),
    ).resolves.toBe('gone');
    expect(execInPod).toHaveBeenCalledTimes(1);

    await expect(
      source.closeClient(input, {
        pod: 'pg-pooler-1',
        clientId: 5,
        connectTime: '2026-10-12 07:00:00 UTC',
      }),
    ).resolves.toBe('closed');
    const kill = execInPod.mock.calls.at(-1) as unknown[];
    expect((kill[4] as string[])[2]).toContain('KILL_CLIENT 5;');
    expect(kill[5]).toBe('pg-pooler-1');
  });

  it('treats a pod that is not a running pooler pod of this database as gone', async () => {
    const { source, input, execInPod } = build();
    await expect(
      source.closeClient(input, {
        pod: 'some-other-pod',
        clientId: 5,
        connectTime: '2026-10-12 07:00:00 UTC',
      }),
    ).resolves.toBe('gone');
    expect(execInPod).not.toHaveBeenCalled();
  });
});
