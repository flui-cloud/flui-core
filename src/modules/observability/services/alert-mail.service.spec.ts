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
    dashboard?: string;
    cluster?: { name: string } | null;
  } = {},
) => {
  const sent: Record<string, unknown>[] = [];
  const config = {
    get: (key: string) =>
      key === 'MAIL_FROM'
        ? (over.from ?? 'noreply@example.test')
        : key === 'MAIL_FROM_NAME'
          ? 'Flui'
          : key === 'FRONTEND_URL'
            ? over.dashboard
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
  const clusters = { findOne: async () => over.cluster ?? null };
  return {
    sent,
    service: new AlertMailService(
      config as never,
      sender as never,
      users as never,
      clusters as never,
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
  it('emails administrators a warning nobody owns once the installation opted in', async () => {
    const { service, sent } = build();
    const delivered = await service.deliver(
      'fired',
      event({ severity: 'warning' }),
      { ownerUserId: null, adminWarnings: true },
    );
    expect(delivered).toBe(true);
    expect(sent[0].to).toEqual([{ email: 'admin@example.test' }]);
  });

  it('keeps an application’s warning out of the inbox even when opted in', async () => {
    const { service, sent } = build({ owner: { email: 'owner@example.test' } });
    await service.deliver('fired', event({ severity: 'warning' }), {
      ownerUserId: 'u1',
      adminWarnings: true,
    });
    expect(sent).toHaveLength(0);
  });

  it('sends to chosen addresses and reports a refusal instead of throwing', async () => {
    const { service, sent } = build();
    expect(
      await service.sendTo('fired', event(), ['oncall@example.test']),
    ).toEqual({ sent: true });
    expect(sent[0].to).toEqual([{ email: 'oncall@example.test' }]);

    const unconfigured = build({ from: '' });
    expect(
      (await unconfigured.service.sendTo('fired', event(), ['x@example.test']))
        .sent,
    ).toBe(false);
  });

  it('says nothing at all when no sender is configured', async () => {
    const { service, sent } = build({ from: '' });

    expect(await service.deliver('fired', event())).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('carries what happened, to what, and since when', async () => {
    const { service, sent } = build();

    await service.deliver('fired', event({ nodeInstance: 'node-1' }));

    expect(sent[0].subject).toBe('Critical: Node node-1 is not reporting');
    expect(sent[0].text).toContain('Node node-1 is not reporting');
    expect(sent[0].text).toContain('1 Jan 2020, 00:00 UTC');
    expect(sent[0].html).toContain('Node node-1 is not reporting');
  });

  it('says so when it recovers', async () => {
    const { service, sent } = build();

    await service.deliver(
      'resolved',
      event({ status: 'resolved', endsAt: new Date('2020-01-01T00:20:00Z') }),
    );

    expect(sent[0].subject).toBe('Recovered: Node node-1 is not reporting');
    expect(sent[0].text).toContain('Recovered: Node node-1 is not reporting');
    expect(sent[0].text).toContain('Lasted        20m');
    expect(sent[0].text).not.toContain('one more message');
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
      { findOne: async () => null } as never,
    );

    await expect(failing.deliver('fired', event())).resolves.toBe(false);
    expect(service).toBeDefined();
  });

  /**
   * A platform backup failing at four in the morning must say which
   * installation, which cluster, and where to look.
   */
  it('says which installation and cluster it is about and links to the page that answers it', async () => {
    const { service, sent } = build({
      dashboard: 'https://app.cheerful-meerkat.example.test',
      cluster: { name: 'control-cluster-staging' },
    });

    await service.deliver(
      'fired',
      event({
        alertname: 'FluiBackupFailed',
        fluiKind: 'backup',
        clusterId: 'c1',
        labels: { policy: 'flui-control-plane' },
        annotations: {
          summary:
            'Backup "flui-control-plane" failed: We encountered an internal error. Please try again.',
        },
      }),
    );

    const mail = sent[0] as Record<string, string>;
    expect(mail.subject).toMatch(
      /^\[cheerful-meerkat\.example\.test\] Critical: Backup "flui-control-plane" failed/,
    );
    expect(mail.text).toContain('Cluster       control-cluster-staging');
    expect(mail.text).toContain('Backup policy flui-control-plane');
    expect(mail.text).toContain(
      'https://app.cheerful-meerkat.example.test/management/backup/overview',
    );
    expect(mail.text).toContain(
      'you are an administrator of this installation',
    );
    expect(mail.html).toContain(
      'href="https://app.cheerful-meerkat.example.test/management/backup/overview"',
    );
    expect(mail.html).toContain(
      'src="https://app.cheerful-meerkat.example.test/icons/logo.png"',
    );
  });

  it('tells an owner why it reached them and links to their application', async () => {
    const { service, sent } = build({
      owner: { email: 'owner@example.test' },
      dashboard: 'https://app.flui.example.test',
    });

    await service.deliver(
      'fired',
      event({ applicationId: 'a1', applicationSlug: 'shop' }),
      { ownerUserId: 'u1' },
    );

    expect(sent[0].text).toContain('because you own shop');
    expect(sent[0].text).toContain(
      'https://app.flui.example.test/apps/applications/a1/monitoring',
    );
  });

  it('escapes what an alert rule or an error message put in the summary', async () => {
    const { service, sent } = build();

    await service.deliver(
      'fired',
      event({ annotations: { summary: '<img src=x onerror=alert(1)>' } }),
    );

    expect(sent[0].html).not.toContain('<img');
    expect(sent[0].html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('leaves the link out rather than inventing a dashboard address', async () => {
    const { service, sent } = build();

    await service.deliver('fired', event());

    expect(sent[0].text).not.toContain('Open in the dashboard');
    expect(sent[0].html).not.toContain('href=');
    expect(sent[0].html).not.toContain('<img');
  });
});
