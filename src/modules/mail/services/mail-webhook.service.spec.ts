import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hmacSha256Hex, type DeliveryEvent } from '@flui-cloud/mail';
import { MailWebhookService } from './mail-webhook.service';
import { MailConnectionService } from './mail-connection.service';
import { MailEventStoreService } from './mail-event-store.service';
import { MailSuppressionService } from './mail-suppression.service';
import { MailConnectionEntity } from '../entities/mail-connection.entity';

const BREVO_SECRET = 'brevo-shared-secret';
const ZEPTO_SECRET = 'zepto-signing-key';

function connection(over: Partial<MailConnectionEntity>): MailConnectionEntity {
  return {
    id: 'c1',
    provider: 'brevo',
    scope: 'bulk',
    label: 'Brevo (bulk)',
    sendingDomain: 'news.example.com',
    credentialSource: 'inline',
    encryptedSecret: 'enc:key',
    secretFingerprint: null,
    config: {},
    encryptedWebhookSecret: 'enc:secret',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as MailConnectionEntity;
}

async function build(connections: MailConnectionEntity[]) {
  const stored: DeliveryEvent[] = [];
  const suppressed: DeliveryEvent[] = [];

  const moduleRef = await Test.createTestingModule({
    providers: [
      MailWebhookService,
      {
        provide: MailConnectionService,
        useValue: {
          activeAll: async () => connections,
          webhookSecretOf: (c: MailConnectionEntity) =>
            c.provider === 'brevo' ? BREVO_SECRET : ZEPTO_SECRET,
        },
      },
      {
        provide: MailEventStoreService,
        useValue: {
          record: async (events: DeliveryEvent[]) => {
            stored.push(...events);
            return events.length;
          },
        },
      },
      {
        provide: MailSuppressionService,
        useValue: {
          recordEvents: async (events: DeliveryEvent[]) => {
            suppressed.push(...events);
          },
        },
      },
    ],
  }).compile();

  return { service: moduleRef.get(MailWebhookService), stored, suppressed };
}

const BOUNCE = {
  event: 'hard_bounce',
  email: 'gone@example.net',
  'message-id': '<m1@relay>',
  ts_event: 1_754_900_000,
  reason: 'unknown recipient',
  'X-Mailin-custom': 'news@example.com',
};

describe('receiving pushed delivery events', () => {
  it('refuses a call with no token before parsing anything', async () => {
    const { service, stored } = await build([connection({})]);

    await expect(
      service.handle('brevo', {}, '', BOUNCE),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // Nothing may reach the store on an unauthenticated call: this endpoint
    // writes the do-not-send list, so a stranger who can post here can stop an
    // operator emailing whoever they choose.
    expect(stored).toHaveLength(0);
  });

  it('refuses a wrong token', async () => {
    const { service } = await build([connection({})]);
    await expect(
      service.handle('brevo', { authorization: 'Bearer not-it' }, '', BOUNCE),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts the token it registered, and folds the bounce into suppressions', async () => {
    const { service, stored, suppressed } = await build([connection({})]);

    const result = await service.handle(
      'brevo',
      { authorization: `Bearer ${BREVO_SECRET}` },
      '',
      BOUNCE,
    );

    expect(result).toEqual({ received: 1, stored: 1 });
    expect(stored[0]).toMatchObject({
      kind: 'bounced',
      recipient: 'gone@example.net',
      from: 'news@example.com',
      permanent: true,
    });
    expect(suppressed).toHaveLength(1);
  });

  it('identifies which connection sent it, as a side effect of authenticating', async () => {
    // Two Brevo accounts, one per scope, both posting to the same URL. The
    // token is the only thing that tells them apart.
    const { service } = await build([
      connection({
        id: 'other',
        provider: 'zeptomail',
        scope: 'transactional',
      }),
      connection({ id: 'brevo-bulk' }),
    ]);

    await expect(
      service.handle(
        'brevo',
        { authorization: `Bearer ${BREVO_SECRET}` },
        '',
        BOUNCE,
      ),
    ).resolves.toMatchObject({ received: 1 });
  });

  it('verifies ZeptoMail over the raw bytes, not a re-serialised body', async () => {
    const { service } = await build([
      connection({ id: 'z', provider: 'zeptomail', scope: 'transactional' }),
    ]);

    const payload = {
      event_name: 'email_hardbounce',
      event_message: {
        email_info: {
          email_reference: 'ref-1',
          to: [{ email_address: { address: 'gone@example.net' } }],
          from: { address: 'noreply@example.com' },
        },
        event_data: [{ details: { reason: 'no such user' } }],
      },
    };
    const raw = JSON.stringify(payload);
    const ts = Date.now();
    const header = `ts=${ts};s=${await hmacSha256Hex(ZEPTO_SECRET, `${ts}${raw}`)};s-algorithm=HmacSHA256`;

    await expect(
      service.handle(
        'zeptomail',
        { 'producer-signature': header },
        raw,
        payload,
      ),
    ).resolves.toMatchObject({ received: 1 });

    // The same signature over different bytes must not pass.
    await expect(
      service.handle(
        'zeptomail',
        { 'producer-signature': header },
        JSON.stringify(payload, null, 2),
        payload,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts an authenticated call that maps to nothing, without touching the store', async () => {
    const { service, stored } = await build([connection({})]);

    // `opened` is not a delivery outcome. Authenticated and uninteresting is a
    // 200 with zero, not an error.
    const result = await service.handle(
      'brevo',
      { authorization: `Bearer ${BREVO_SECRET}` },
      '',
      { ...BOUNCE, event: 'opened' },
    );

    expect(result).toEqual({ received: 0, stored: 0 });
    expect(stored).toHaveLength(0);
  });
});
