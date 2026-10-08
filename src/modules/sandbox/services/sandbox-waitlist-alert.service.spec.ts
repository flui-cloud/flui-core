jest.mock('../../mail/services/mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));
jest.mock('@kubernetes/client-node', () => ({}));

import { SandboxWaitlistAlertService } from './sandbox-waitlist-alert.service';
import { loadSandboxConfig } from '../sandbox.config';
import { FakeAlertEvents } from '../../observability/testing/fake-alert-events';

describe('SandboxWaitlistAlertService', () => {
  const build = (events = new FakeAlertEvents()) => {
    const state = { waiting: 0 };
    const deliver = jest.fn(
      async (_kind: string, _event: unknown, _opts?: unknown) => true,
    );
    const service = new SandboxWaitlistAlertService(
      { count: async () => state.waiting } as never,
      events as never,
      { deliver } as never,
      loadSandboxConfig({ SANDBOX_ENABLED: 'true' }),
    );
    return { service, state, events, deliver };
  };

  it('says when people start waiting and when the line clears, to the administrators', async () => {
    const { service, state, events, deliver } = build();
    const now = new Date();

    await service.check(now);
    state.waiting = 3;
    await service.check(now);
    await service.check(new Date(now.getTime() + 300_000));
    state.waiting = 0;
    await service.check(now);
    await service.check(now);

    expect(events.episodes.map((e) => e.status)).toEqual(['resolved']);
    expect(deliver.mock.calls.map((c) => c[0])).toEqual(['fired', 'resolved']);
    expect(deliver).toHaveBeenCalledWith('fired', expect.anything(), {
      adminWarnings: true,
    });
  });

  it('closes the episode a previous process opened, and never opens a second one', async () => {
    const events = new FakeAlertEvents();
    const first = build(events);
    first.state.waiting = 1;
    await first.service.check(new Date('2026-10-08T13:40:00Z'));

    const afterRestart = build(events);
    afterRestart.state.waiting = 1;
    await afterRestart.service.check(new Date('2026-10-08T13:45:00Z'));
    afterRestart.state.waiting = 0;
    await afterRestart.service.check(new Date('2026-10-08T13:50:00Z'));

    expect(events.episodes).toHaveLength(1);
    expect(events.episodes[0].status).toBe('resolved');
    expect(afterRestart.deliver.mock.calls.map((c) => c[0])).toEqual([
      'resolved',
    ]);
  });
});
