import {
  workloadNamesFor,
  workloadReferences,
} from './topology-workload-refs.util';

describe('workloadReferences', () => {
  it('reads the hosts a platform configuration names, with their ports', () => {
    const refs = workloadReferences(
      [
        { key: 'DB_HOST', value: 'postgres' },
        { key: 'DB_PORT', value: '5432' },
        { key: 'REDIS_HOST', value: 'redis' },
        { key: 'REDIS_PORT', value: '6379' },
        {
          key: 'PROMETHEUS_ENDPOINT',
          value: 'http://vmsingle.flui-control:8428',
        },
        {
          key: 'LOKI_ENDPOINT',
          value: 'http://loki.flui-control.svc.cluster.local:3100/loki',
        },
      ],
      'flui-system',
    );
    expect(refs).toEqual([
      { name: 'postgres', namespace: 'flui-system', port: 5432 },
      { name: 'redis', namespace: 'flui-system', port: 6379 },
      { name: 'vmsingle', namespace: 'flui-control', port: 8428 },
      { name: 'loki', namespace: 'flui-control', port: 3100 },
    ]);
  });

  it('leaves public addresses and plain words alone', () => {
    const refs = workloadReferences(
      [
        { key: 'API_BASE_URL', value: 'https://api.example.com' },
        { key: 'DB_USER', value: 'postgres' },
        { key: 'GREETING', value: 'hello world' },
      ],
      'flui-system',
    );
    expect(refs).toEqual([]);
  });

  it('reads host:port inside a longer value', () => {
    expect(
      workloadReferences(
        [{ key: 'NATS_URL', value: 'nats://nats:4222' }],
        'shop',
      ),
    ).toEqual([{ name: 'nats', namespace: 'shop', port: 4222 }]);
    expect(
      workloadReferences(
        [{ key: 'ADDRS', value: 'redis-a:6379,redis-b:6379' }],
        'shop',
      ).map((r) => r.name),
    ).toEqual(['redis-a', 'redis-b']);
  });

  it('reads the hosts an init container waits for', () => {
    const refs = workloadReferences(
      [
        {
          key: 'COMMAND',
          value: 'sh -c until nc -z postgres 5432; do sleep 2; done',
        },
      ],
      'flui-system',
    );
    expect(refs).toEqual([
      { name: 'postgres', namespace: 'flui-system', port: 5432 },
    ]);
  });

  it('matches a service to the workload behind it', () => {
    expect(workloadNamesFor('shop-svc')).toEqual(['shop-svc', 'shop']);
    expect(workloadNamesFor('postgres')).toEqual(['postgres']);
  });
});
