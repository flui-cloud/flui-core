jest.mock('../../mail/services/mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));
jest.mock('@kubernetes/client-node', () => ({}));

import { SandboxCpuAlertService } from './sandbox-cpu-alert.service';
import { loadSandboxConfig } from '../sandbox.config';
import { FakeAlertEvents } from '../../observability/testing/fake-alert-events';

describe('SandboxCpuAlertService', () => {
  const NOW = new Date('2026-10-07T15:00:00Z');

  const build = (
    hot: Array<{ namespace: string; app: string; v: string }>,
    events = new FakeAlertEvents(),
  ) => {
    const recorded: Array<{
      fingerprint: string;
      status: string;
      labels: Record<string, string>;
      annotations: Record<string, string>;
    }> = [];
    const queries: string[] = [];
    const state = { hot };
    const service = new SandboxCpuAlertService(
      {
        find: async () => [
          {
            id: 't1',
            namespace: 'p-personal-aaaa',
            email: 'mario@example.com',
            clusterId: 'c1',
          },
        ],
      } as never,
      {
        queryInstant: async (q: string) => {
          queries.push(q);
          return {
            status: 'success',
            data: {
              resultType: 'vector',
              result: state.hot.map((h) => ({
                metric: {
                  namespace: h.namespace,
                  label_app_kubernetes_io_name: h.app,
                },
                value: [0, h.v],
              })),
            },
          };
        },
      } as never,
      {
        record: async (batch: typeof recorded) => {
          recorded.push(...batch);
          return events.record(batch as never);
        },
        openEpisodes: (prefix: string) => events.openEpisodes(prefix),
      } as never,
      { deliver: jest.fn(async () => true) } as never,
      loadSandboxConfig({
        SANDBOX_CPU_ALERT_PERCENT: '85',
        SANDBOX_CPU_ALERT_MINUTES: '20',
      }),
    );
    return { service, recorded, queries, state, events };
  };

  it('asks for apps held at the configured share for the configured time', async () => {
    const { service, queries } = build([]);

    await service.check(NOW);

    expect(queries).toEqual([
      'min_over_time(flui:app_cpu_utilization_percent[20m]) >= 85',
    ]);
  });

  it('raises a critical alert naming the guest, only for a guest area', async () => {
    const { service, recorded } = build([
      { namespace: 'p-personal-aaaa', app: 'miner', v: '99.4' },
      { namespace: 'p-web-team', app: 'api', v: '97' },
    ]);

    await service.check(NOW);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      fingerprint: 'sandbox-cpu/p-personal-aaaa/miner',
      status: 'firing',
      labels: { guest: 'mario@example.com' },
    });
    expect(recorded[0].annotations.summary).toContain('99%');
  });

  it('closes the alert once the application calms down', async () => {
    const { service, recorded, state } = build([
      { namespace: 'p-personal-aaaa', app: 'miner', v: '99' },
    ]);

    await service.check(NOW);
    state.hot = [];
    await service.check(new Date(NOW.getTime() + 300_000));
    await service.check(new Date(NOW.getTime() + 600_000));

    expect(recorded.map((r) => r.status)).toEqual(['firing', 'resolved']);
  });

  it('closes, after a restart, an alert a previous process raised', async () => {
    const events = new FakeAlertEvents();
    await build(
      [{ namespace: 'p-personal-aaaa', app: 'miner', v: '99' }],
      events,
    ).service.check(NOW);

    const afterRestart = build([], events);
    await afterRestart.service.check(new Date(NOW.getTime() + 300_000));

    expect(events.episodes).toHaveLength(1);
    expect(events.episodes[0].status).toBe('resolved');
  });
});
