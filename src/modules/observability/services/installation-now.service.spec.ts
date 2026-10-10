jest.mock('@kubernetes/client-node', () => ({}));

import { RegistryTrafficService } from '../../flui-registry/services/registry-traffic.service';
import { SandboxCapacityService } from '../../sandbox/services/sandbox-capacity.service';
import { InstallationNowService } from './installation-now.service';
import { trafficWatchConfigFrom } from './traffic-watch.config';

const series = (metric: Record<string, string>, value: number) => ({
  metric,
  value: [0, String(value)],
});

const harness = (
  env: Record<string, string>,
  opts: { registryFails?: boolean } = {},
) => {
  const service = new InstallationNowService(
    { get: (k: string) => env[k] } as never,
    {
      queryInstant: async (q: string) => {
        if (q.includes('node_cpu_seconds_total')) {
          return {
            data: {
              result: [series({ cluster_id: 'c1', instance: 'n1' }, 42)],
            },
          };
        }
        if (q.includes('node_memory_MemAvailable_bytes')) {
          return {
            data: {
              result: [series({ cluster_id: 'c1', instance: 'n1' }, 71)],
            },
          };
        }
        if (q.startsWith('flui:app_cpu_utilization_percent')) {
          return {
            data: {
              result: [
                series({ label_app_kubernetes_io_name: 'flui-api' }, 35),
              ],
            },
          };
        }
        if (q.startsWith('flui:app_memory_utilization_percent')) {
          return {
            data: {
              result: [
                series({ label_app_kubernetes_io_name: 'flui-api' }, 52),
                series({ label_app_kubernetes_io_name: 'postgres' }, 18),
              ],
            },
          };
        }
        if (q.startsWith('flui:app_restart_rate_1h')) {
          return {
            data: {
              result: [series({ label_app_kubernetes_io_name: 'postgres' }, 2)],
            },
          };
        }
        return { data: { result: [] } };
      },
    } as never,
    {
      config: trafficWatchConfigFrom(() => undefined),
      read: async () => ({
        measuredAt: new Date('2026-10-09T18:00:00Z'),
        nodes: [
          {
            clusterId: 'c1',
            node: 'n1',
            mbpsOut: 3,
            mbpsIn: 1,
            monthPaceBytes: 1e12,
            includedTb: 20,
          },
        ],
        edges: [
          {
            clusterId: 'c1',
            rpsNow: 2,
            rpsBefore: 1,
            rateLimited10m: 0,
            requests10m: 900,
            serverErrors10m: 0,
          },
        ],
      }),
    } as never,
    { find: async () => [{ id: 'c1', name: 'control' }] } as never,
    {
      find: async () => [
        { alertname: 'FluiTrafficSurge', severity: 'warning' },
        { alertname: 'FluiEdgeServerErrors', severity: 'critical' },
        { alertname: 'FluiTrafficSurge', severity: 'warning' },
      ],
    } as never,
    { count: async () => 4 } as never,
    {
      get: (token: unknown) => {
        if (token === RegistryTrafficService) {
          return {
            traffic: async () => {
              if (opts.registryFails) throw new Error('no metrics');
              return { window: '1h', bytesOut: 10 };
            },
          };
        }
        if (token === SandboxCapacityService) {
          return {
            snapshot: async () => ({
              live: 7,
              warm: 2,
              ceiling: 12,
              fullRefusals: 1,
            }),
          };
        }
        return null;
      },
    } as never,
  );
  return service;
};

describe('the installation, now', () => {
  it('puts nodes, doors, platform, registry, demo and alerts in one reading', async () => {
    const now = await harness({
      FLUI_IMAGE_REGISTRY: 'flui',
      SANDBOX_ENABLED: 'true',
    }).read();
    expect(now.nodes[0]).toMatchObject({
      clusterName: 'control',
      cpuPercent: 42,
      memoryPercent: 71,
      mbpsOut: 3,
    });
    expect(now.edges[0]).toMatchObject({ clusterName: 'control', rpsNow: 2 });
    expect(now.platform).toEqual([
      {
        name: 'flui-api',
        cpuPercent: 35,
        memoryPercent: 52,
        restartsLastHour: 0,
      },
      {
        name: 'postgres',
        cpuPercent: null,
        memoryPercent: 18,
        restartsLastHour: 2,
      },
    ]);
    expect(now.registry).toMatchObject({ window: '1h' });
    expect(now.sandbox).toEqual({
      live: 7,
      warm: 2,
      ceiling: 12,
      waiting: 4,
      fullRefusals: 1,
    });
    expect(now.alerts).toEqual({
      firing: 3,
      critical: 1,
      names: ['FluiEdgeServerErrors', 'FluiTrafficSurge'],
    });
    expect(now.thresholds.nodeMbps).toBe(500);
  });

  it('leaves out what the installation does not run', async () => {
    const now = await harness({}).read();
    expect(now.registry).toBeNull();
    expect(now.sandbox).toBeNull();
  });

  it('keeps the rest of the screen when one part cannot be read', async () => {
    const now = await harness(
      { FLUI_IMAGE_REGISTRY: 'flui' },
      { registryFails: true },
    ).read();
    expect(now.registry).toBeNull();
    expect(now.nodes).toHaveLength(1);
  });
});
