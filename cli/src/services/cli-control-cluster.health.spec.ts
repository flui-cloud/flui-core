// `chalk` is ESM and arrives here only through an import chain this test never
// exercises; a passthrough keeps the module loader out of the way.
jest.mock('chalk', () => {
  const identity = (text: unknown) => String(text);
  return {
    __esModule: true,
    default: new Proxy(identity, { get: () => identity }),
  };
});

import { CliControlClusterService } from './cli-control-cluster.service';

const workload = (
  namespace: string,
  name: string,
  ready: number,
  want: number,
) => ({
  metadata: { name, namespace },
  status: { readyReplicas: ready, replicas: want },
});

const build = (sshExec: () => Promise<string>) =>
  new CliControlClusterService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { sshExec } as never,
  );

const answering = (items: unknown[]) => {
  const control = JSON.stringify({ items });
  const empty = JSON.stringify({ items: [] });
  return async () => [control, empty, control].join('---FLUI-SEP---');
};

describe('what the health check says when it could not ask', () => {
  /**
   * Reaching the master is a precondition of asking, so a failure there is not
   * an answer about the services. Reported as seven services being down, it
   * sends somebody hunting a fault in a cluster that is almost certainly fine
   * — which is what a blocked SSH port on a healthy installation produced.
   */
  it('says the check never ran, rather than that everything is down', async () => {
    const service = build(async () => {
      throw new Error(
        'ssh: connect to host 10.0.0.1 port 22: Operation timed out',
      );
    });

    const health = await service.checkObservabilityServices('10.0.0.1');

    expect(health.checked).toBe(false);
    expect(health.reason).toContain('port 22');
    expect(health.prometheus).toBe('unknown');
    expect(health.fluiApi).toBe('unknown');
  });

  it('never reports a service as unreachable on a failed check', async () => {
    const service = build(async () => {
      throw new Error('no route to host');
    });

    const health = await service.checkObservabilityServices('10.0.0.1');
    const readings = [
      health.prometheus,
      health.grafana,
      health.loki,
      health.postgres,
      health.redis,
      health.fluiApi,
      health.fluiWeb,
    ];

    expect(readings.every((r) => r === 'unknown')).toBe(true);
  });
});

describe('what it says when it did ask', () => {
  it('reads a ready workload as healthy', async () => {
    const service = build(
      answering([
        workload('flui-control', 'grafana', 1, 1),
        workload('flui-system', 'flui-api', 2, 2),
      ]),
    );

    const health = await service.checkObservabilityServices('10.0.0.1');

    expect(health.checked).toBe(true);
    expect(health.grafana).toBe('healthy');
    expect(health.fluiApi).toBe('healthy');
  });

  /**
   * Only once the master has answered does `unreachable` mean anything: here it
   * is a workload that really is short of its replicas, or absent entirely.
   */
  it('reads a workload short of its replicas as unreachable', async () => {
    const service = build(
      answering([workload('flui-control', 'grafana', 0, 1)]),
    );

    const health = await service.checkObservabilityServices('10.0.0.1');

    expect(health.checked).toBe(true);
    expect(health.grafana).toBe('unreachable');
    expect(health.redis).toBe('unreachable');
  });
});
