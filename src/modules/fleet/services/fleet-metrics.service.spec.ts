import { FleetMetricsService } from './fleet-metrics.service';
import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';

const NOW = new Date('2026-09-27T12:00:00Z');
const END = Math.floor(NOW.getTime() / 1000 / 60) * 60;

const cluster = (id: string, status = ClusterStatus.READY) => ({
  id,
  name: `cluster-${id}`,
  provider: 'hetzner',
  clusterType: 'workload',
  status,
});

function history(nodes: Record<string, number[]>) {
  return new Map(
    Object.entries(nodes).map(([instance, cpus]) => [
      instance,
      {
        server_id: instance,
        data_points: cpus.map((cpu, i) => ({
          timestamp: END - (cpus.length - 1 - i) * 60,
          cpu_percent: cpu,
          memory_percent: cpu * 2,
          disk_percent: 10,
          network_in: 100,
          network_out: 10,
        })),
      },
    ]),
  );
}

describe('FleetMetricsService', () => {
  function build(byCluster: Record<string, unknown>) {
    const prometheus = {
      getMetricsHistory: jest.fn(async (id: string) => {
        const v = byCluster[id];
        if (v instanceof Error) throw v;
        return v;
      }),
    };
    const clusters = {
      find: jest.fn(async () => [
        cluster('a'),
        cluster('b'),
        cluster('c', ClusterStatus.CREATING),
      ]),
    };
    return {
      prometheus,
      service: new FleetMetricsService(prometheus as never, clusters as never),
    };
  }

  it('reads every cluster through the Monitoring query and aggregates the fleet', async () => {
    const { service, prometheus } = build({
      a: history({ n1: [10, 20], n2: [30, 40] }),
      b: history({ n3: [60] }),
      c: new Map(),
    });

    const result = await service.getMetrics('3h', NOW);

    expect(prometheus.getMetricsHistory).toHaveBeenCalledWith(
      'a',
      END - 10_800,
      END,
      '1m',
    );
    expect(result.window).toBe('3h');
    expect(result.fleet).toMatchObject({
      clustersTotal: 3,
      clustersReporting: 2,
      nodesReporting: 3,
    });
    expect(result.fleet.current).toMatchObject({
      cpuPercent: 40,
      networkInBytesPerSecond: 300,
      nodes: 3,
    });
    const [a, b, c] = result.clusters;
    expect(a).toMatchObject({ metrics: 'reporting', nodesReporting: 2 });
    expect(a.current?.cpuPercent).toBe(30);
    expect(b.current?.cpuPercent).toBe(60);
    expect(c).toMatchObject({
      metrics: 'no_data',
      current: null,
      series: [],
      status: 'creating',
    });
  });

  it('says a cluster could not be read instead of counting it as zero', async () => {
    const { service } = build({
      a: new Error('Prometheus range query failed'),
      b: new Map(),
      c: new Map(),
    });

    const result = await service.getMetrics('1h', NOW);

    expect(result.clusters[0]).toMatchObject({
      metrics: 'unavailable',
      current: null,
    });
    expect(result.fleet).toMatchObject({
      clustersReporting: 0,
      nodesReporting: 0,
      current: null,
      series: [],
    });
  });

  it('keeps an old reading as history but not as the current value', async () => {
    const stale = history({ n1: [50] });
    const node = stale.get('n1')!;
    node.data_points[0].timestamp = END - 3_600;
    const { service } = build({ a: stale, b: new Map(), c: new Map() });

    const result = await service.getMetrics('3h', NOW);

    expect(result.clusters[0]).toMatchObject({
      metrics: 'stale',
      current: null,
      nodesReporting: 0,
    });
    expect(result.clusters[0].lastSampleAt).toBe(
      new Date((END - 3_600) * 1000).toISOString(),
    );
    expect(result.fleet.series).toHaveLength(1);
    expect(result.fleet.current).toBeNull();
  });
});
