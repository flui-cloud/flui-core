// Same cut the mail module's own specs make: importing the sender for its type
// drags in the provider chain, and one package in it is ESM.
jest.mock('../../mail/services/mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));

import { AlertMailService } from './alert-mail.service';
import { AlertEventEntity } from '../entities/alert-event.entity';

const event = (over: Partial<AlertEventEntity> = {}): AlertEventEntity =>
  ({
    id: 'e1',
    fingerprint: 'fp1',
    alertname: 'FluiNodeDown',
    severity: 'critical',
    status: 'firing',
    startsAt: new Date('2020-01-01T00:00:00Z'),
    endsAt: null,
    annotations: { summary: 'Node node-1 is not reporting' },
    labels: {},
    ...over,
  }) as AlertEventEntity;

const build = (
  over: {
    from?: string;
    admins?: { email: string }[];
    owner?: { email: string } | null;
  } = {},
) => {
  const sent: Record<string, unknown>[] = [];
  const config = {
    get: (key: string) =>
      key === 'MAIL_FROM'
        ? (over.from ?? 'noreply@example.test')
        : key === 'MAIL_FROM_NAME'
          ? 'Flui'
          : undefined,
  };
  const sender = {
    send: async (req: Record<string, unknown>) => {
      sent.push(req);
      return { accepted: 1 };
    },
  };
  const users = {
    findOne: async () => over.owner ?? null,
    find: async () => over.admins ?? [{ email: 'admin@example.test' }],
  };
  return {
    sent,
    service: new AlertMailService(
      config as never,
      sender as never,
      users as never,
    ),
  };
};

describe('AlertMailService', () => {
  /**
   * The half that used to reach nobody: an alert about a node owns no
   * application, so the bell had no one to ring and the row was written and
   * forgotten.
   */
  it('sends an ownerless alert to the instance’s administrators', async () => {
    const { service, sent } = build();

    expect(await service.deliver('fired', event())).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([{ email: 'admin@example.test' }]);
  });

  it('sends an application’s alert to whoever owns it, not to the administrators', async () => {
    const { service, sent } = build({ owner: { email: 'guest@example.test' } });

    await service.deliver('fired', event({ applicationSlug: 'shop' }), {
      ownerUserId: 'u1',
    });

    expect(sent[0].to).toEqual([{ email: 'guest@example.test' }]);
  });

  // A warning at three in the morning teaches people to filter the sender, and
  // then the critical one has no audience left.
  it('leaves anything below critical to the dashboard bell', async () => {
    const { service, sent } = build();

    expect(await service.deliver('fired', event({ severity: 'warning' }))).toBe(
      false,
    );
    expect(sent).toHaveLength(0);
  });

  // Same switch as every other product email: unset means email is not set up
  // here, rather than a sender invented on an unverified domain.
  it('says nothing at all when no sender is configured', async () => {
    const { service, sent } = build({ from: '' });

    expect(await service.deliver('fired', event())).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('carries what happened, to what, and since when', async () => {
    const { service, sent } = build();

    await service.deliver('fired', event({ nodeInstance: 'node-1' }));

    expect(sent[0].subject).toBe('critical: node-1');
    expect(sent[0].text).toContain('Node node-1 is not reporting');
    expect(sent[0].text).toContain('2020-01-01T00:00:00.000Z');
  });

  it('says so when it recovers', async () => {
    const { service, sent } = build();

    await service.deliver(
      'resolved',
      event({ status: 'resolved', endsAt: new Date('2020-01-01T00:20:00Z') }),
    );

    expect(sent[0].subject).toBe('Recovered: FluiNodeDown');
    expect(sent[0].text).toContain('This has recovered.');
  });

  /**
   * The volume alerts exist so somebody can decide whether to spend money on
   * more disk. Telling them a volume is full and leaving them to go and look up
   * the command is the difference between being notified and being told.
   */
  it('carries the command when the rule says what to do', async () => {
    const { service, sent } = build();

    await service.deliver(
      'fired',
      event({
        alertname: 'FluiVolumeCriticallyFull',
        annotations: {
          summary: 'Volume data-shop-postgres-0 is over 90% full',
          action:
            'flui app volume resize shop --volume data-shop-postgres-0 --size 40',
        },
      }),
    );

    expect(sent[0].text).toContain('To fix it:');
    expect(sent[0].text).toContain('flui app volume resize shop');
  });

  it('says nothing about fixing it when the rule offers no command', async () => {
    const { service, sent } = build();

    await service.deliver('fired', event());

    expect(sent[0].text).not.toContain('To fix it:');
  });

  // A mail provider having a bad morning must not take down the route
  // Alertmanager is calling.
  it('never throws when the provider refuses', async () => {
    const { service } = build();
    const failing = new AlertMailService(
      { get: () => 'noreply@example.test' } as never,
      {
        send: async () => {
          throw new Error('provider down');
        },
      } as never,
      {
        findOne: async () => null,
        find: async () => [{ email: 'a@b.test' }],
      } as never,
    );

    await expect(failing.deliver('fired', event())).resolves.toBe(false);
    expect(service).toBeDefined();
  });
});
