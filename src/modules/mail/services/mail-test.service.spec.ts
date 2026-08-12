jest.mock('./mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));
jest.mock('./mail-suppression.service', () => ({
  MailSuppressionService: class MailSuppressionService {},
}));

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MailTestService } from './mail-test.service';
import { MailSendService } from './mail-send.service';
import { MailSuppressionService } from './mail-suppression.service';

interface SentMessage {
  from: { email: string };
  to: { email: string }[];
  subject: string;
  scope?: string;
}

describe('MailTestService', () => {
  let service: MailTestService;
  let sent: SentMessage[];
  let sentThrough: unknown[];
  let suppressed: string[];
  let env: Record<string, string>;

  beforeEach(async () => {
    sent = [];
    sentThrough = [];
    suppressed = [];
    env = {};

    const moduleRef = await Test.createTestingModule({
      providers: [
        MailTestService,
        {
          provide: MailSendService,
          useValue: {
            send: async (message: SentMessage, using?: unknown) => {
              sent.push(message);
              sentThrough.push(using);
              return {
                provider: 'scaleway-tem',
                messageId: 'mid-1',
                accepted: 1,
              };
            },
            providerNameFor: async () => 'scaleway-tem',
          },
        },
        {
          provide: MailSuppressionService,
          useValue: {
            suppressed: async (addresses: string[]) =>
              addresses
                .filter((a) => suppressed.includes(a))
                .map((address) => ({
                  address,
                  reason: 'bounce',
                  scope: 'all',
                  at: 'now',
                })),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
      ],
    }).compile();

    service = moduleRef.get(MailTestService);
  });

  describe('draft', () => {
    it('hands back the whole message, so nothing is sent to an address nobody saw', async () => {
      // The first version of this sent on the first click with the recipient
      // behind a placeholder. An outbound, irreversible action has to say where
      // it is going before it goes.
      const draft = service.draft('acme.test', 'me@example.net');

      expect(draft.delivery.to).toBe('me@example.net');
      expect(draft.delivery.from).toBe('noreply@acme.test');
      expect(draft.delivery.subject).toContain('acme.test');
      expect(draft.delivery.text.length).toBeGreaterThan(0);
      expect(sent).toHaveLength(0);
    });

    it('leaves the recipient empty rather than inventing one', () => {
      expect(service.draft('acme.test').delivery.to).toBe('');
    });

    it('drafts what the send will actually use', async () => {
      const draft = service.draft('acme.test', 'me@example.net');

      await service.run('acme.test', 'delivery', { to: 'me@example.net' });

      expect(sent[0]!.subject).toBe(draft.delivery.subject);
    });
  });

  describe('delivery test', () => {
    it('sends the edited message, not the drafted one', async () => {
      // Showing a body and then sending a different one would make the form
      // theatre.
      await service.run('acme.test', 'delivery', {
        to: 'me@example.net',
        subject: 'Edited subject',
        text: 'Edited body',
      });

      expect(sent[0]!.subject).toBe('Edited subject');
    });

    it('carries exactly one recipient', async () => {
      // The line between a test and a sending channel is the ability to address
      // people who did not trigger the message.
      await service.run('acme.test', 'delivery', { to: 'me@example.net' });

      expect(sent[0]!.to).toHaveLength(1);
    });

    it('sends from the domain under test, not from wherever MAIL_FROM points', async () => {
      // Sending from another domain would test that domain and report the answer
      // under the wrong heading.
      env['MAIL_FROM'] = 'noreply@somewhere-else.test';

      await service.run('acme.test', 'delivery', { to: 'me@example.net' });

      expect(sent[0]!.from.email).toBe('noreply@acme.test');
    });

    it('uses the configured sender when it does belong to this domain', async () => {
      env['MAIL_FROM'] = 'hello@acme.test';

      await service.run('acme.test', 'delivery', { to: 'me@example.net' });

      expect(sent[0]!.from.email).toBe('hello@acme.test');
    });

    it('refuses without a recipient rather than picking one', async () => {
      // The caller's own address is the default, resolved at the controller from
      // the authenticated user. Nothing here should invent a destination.
      await expect(service.run('acme.test', 'delivery')).rejects.toThrow(
        /No recipient/,
      );
      expect(sent).toHaveLength(0);
    });
  });

  describe('probing one connection rather than the domain', () => {
    it('goes through the provider it was pointed at, at that provider’s scope', async () => {
      const driver = { id: 'brevo' } as never;

      await service.run(
        'news.example.com',
        'delivery',
        { to: 'me@example.test' },
        { scope: 'bulk', driver, provider: 'brevo' },
      );

      // Both halves matter. The driver, because a provider configured and not
      // yet sending is exactly the one worth proving, and resolving by scope
      // would quietly test the incumbent instead. The scope, because a bulk
      // sender's terms, capability check and suppression rules are all
      // different — probing it as transactional answers a question nobody
      // asked.
      expect(sentThrough[0]).toBe(driver);
      expect(sent[0]?.scope).toBe('bulk');
    });

    it('still goes through whoever holds transactional when nobody says otherwise', async () => {
      await service.run('example.com', 'delivery', { to: 'me@example.test' });

      expect(sentThrough[0]).toBeUndefined();
      expect(sent[0]?.scope).toBe('transactional');
    });
  });

  describe('bounce probe', () => {
    it('addresses a subdomain of the operator’s own domain', async () => {
      // Not an RFC 2606 `.invalid` address: Scaleway rejects those on format,
      // before sending, so the probe would prove only that input is validated.
      // And not somebody else's domain, which is what SES's simulator exists to
      // avoid needing.
      const result = await service.run('acme.test', 'bounce');

      expect(result.to).toBe('bounce-probe@invalid.acme.test');
      expect(sent[0]!.to[0]!.email).toBe('bounce-probe@invalid.acme.test');
    });

    it('sends nothing once the address is suppressed, and says that is the result', async () => {
      suppressed.push('bounce-probe@invalid.acme.test');

      const result = await service.run('acme.test', 'bounce');

      expect(result.alreadySuppressed).toBe(true);
      expect(result.accepted).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it('keeps one probe address rather than a fresh one per run', async () => {
      // A unique address each time would pile up near-identical suppression rows
      // and never exercise the interesting half: the second run being refused
      // before anything is sent.
      const first = await service.run('acme.test', 'bounce');
      const second = await service.run('acme.test', 'bounce');

      expect(second.to).toBe(first.to);
    });
  });
});
