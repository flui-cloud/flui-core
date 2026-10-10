jest.mock('@kubernetes/client-node', () => ({}));

import {
  ApplicationMetricsService,
  rawCpuExpressions,
  safeStep,
} from './application-metrics.service';

const CLUSTER = '23080e08-df4e-4234-b0b2-acc69f629110';

describe('what the history charts read', () => {
  const run = async (step: string) => {
    const asked: string[] = [];
    const service = new ApplicationMetricsService(
      {
        queryRange: async (q: string) => {
          asked.push(q);
          return {
            status: 'success',
            data: {
              resultType: 'matrix',
              result: [
                {
                  metric: {},
                  values: q.includes('flui:app_cpu_limits_cores')
                    ? [[100, '0.5']]
                    : [[100, q.includes('container_cpu_usage') ? '0.5' : '1']],
                },
              ],
            },
          };
        },
      } as never,
      { findById: async () => ({ clusterId: CLUSTER }) } as never,
      { findByApplicationId: async () => [] } as never,
    );
    const points = await service.getAppMetricsHistory(
      'a1',
      'flui-api',
      'flui-system',
      0,
      100,
      step,
    );
    return { asked, points };
  };

  it('keeps the busiest minute and the worst readiness of every step, not one sample of it', async () => {
    const { asked } = await run('5m');
    expect(
      asked.some((q) =>
        q.startsWith(
          'max_over_time(sum(rate(container_cpu_usage_seconds_total',
        ),
      ),
    ).toBe(true);
    expect(
      asked.some((q) =>
        q.startsWith('max_over_time(flui:app_memory_usage_bytes{'),
      ),
    ).toBe(true);
    expect(
      asked.some((q) => q.startsWith('min_over_time(flui:app_replicas_ready{')),
    ).toBe(true);
    expect(
      asked.some((q) =>
        q.includes('container_cpu_cfs_throttled_periods_total'),
      ),
    ).toBe(true);
    expect(
      asked.every((q) => !q.includes('[5m:30s]') || q.includes('[1m]')),
    ).toBe(true);
  });

  it('reads only the application cluster, and series from before the rules carried one', async () => {
    const { asked } = await run('60s');
    expect(
      asked
        .filter((q) => q.includes('flui:app_'))
        .every((q) => q.includes(`cluster_id=~"${CLUSTER}|"`)),
    ).toBe(true);
  });

  it('reports CPU as a share of the limit from the one-minute reading', async () => {
    const { points } = await run('60s');
    expect(points[0].cpu_utilization_percent).toBe(100);
  });

  it('never puts an unexpected step inside a query', () => {
    expect(safeStep('2m')).toBe('2m');
    expect(safeStep('1m] or vector(1) #')).toBe('60s');
  });

  it('joins the containers to the application by cluster, namespace and pod', () => {
    const { usage } = rawCpuExpressions(
      'ns',
      'app',
      `,cluster_id=~"${CLUSTER}|"`,
    );
    expect(usage).toContain('* on (cluster_id, namespace, pod) group_left()');
    expect(usage).toContain('label_app_kubernetes_io_name="app"');
  });
});
