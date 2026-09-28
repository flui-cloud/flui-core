import { aggregateNodes, stateOf } from './fleet-metrics.aggregate';

const T0 = 1_790_000_000;

describe('aggregateNodes', () => {
  it('averages percentages over the nodes reporting and sums network', () => {
    const series = aggregateNodes([
      {
        server_id: 'a',
        data_points: [
          {
            timestamp: T0,
            cpu_percent: 10,
            memory_percent: 40,
            disk_percent: 20,
            network_in: 100,
            network_out: 50,
          },
          { timestamp: T0 + 60, cpu_percent: 20, memory_percent: 42 },
        ],
      },
      {
        server_id: 'b',
        data_points: [
          {
            timestamp: T0,
            cpu_percent: 30,
            memory_percent: 60,
            disk_percent: 40,
            network_in: 300,
            network_out: 150,
          },
        ],
      },
    ]);
    expect(series).toEqual([
      {
        timestamp: new Date(T0 * 1000).toISOString(),
        cpuPercent: 20,
        memoryPercent: 50,
        diskPercent: 30,
        networkInBytesPerSecond: 400,
        networkOutBytesPerSecond: 200,
        nodes: 2,
      },
      {
        timestamp: new Date((T0 + 60) * 1000).toISOString(),
        cpuPercent: 20,
        memoryPercent: 42,
        diskPercent: null,
        networkInBytesPerSecond: null,
        networkOutBytesPerSecond: null,
        nodes: 1,
      },
    ]);
  });

  it('keeps a missing reading missing rather than zero', () => {
    const [point] = aggregateNodes([
      { server_id: 'a', data_points: [{ timestamp: T0, cpu_percent: 5 }] },
    ]);
    expect(point.networkInBytesPerSecond).toBeNull();
    expect(point.memoryPercent).toBeNull();
  });

  it('drops instants where no node reported anything', () => {
    expect(
      aggregateNodes([{ server_id: 'a', data_points: [{ timestamp: T0 }] }]),
    ).toEqual([]);
    expect(aggregateNodes([])).toEqual([]);
  });
});

describe('stateOf', () => {
  const end = new Date((T0 + 600) * 1000);
  const point = (ts: number) => ({
    timestamp: new Date(ts * 1000).toISOString(),
    cpuPercent: 1,
    memoryPercent: 1,
    diskPercent: 1,
    networkInBytesPerSecond: null,
    networkOutBytesPerSecond: null,
    nodes: 1,
  });

  it('reports no data for an empty window', () => {
    expect(stateOf([], end, 60)).toBe('no_data');
  });

  it('is reporting within three steps of the end, stale after', () => {
    expect(stateOf([point(T0 + 480)], end, 60)).toBe('reporting');
    expect(stateOf([point(T0 + 400)], end, 60)).toBe('stale');
  });
});
