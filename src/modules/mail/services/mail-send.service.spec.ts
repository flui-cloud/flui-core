jest.mock('./mail-provider.resolver', () => ({
  MailProviderResolver: class MailProviderResolver {},
}));
jest.mock('./mail-suppression.service', () => ({
  MailSuppressionService: class MailSuppressionService {},
}));
jest.mock('./mail-dns-writer.service', () => ({
  MailDnsWriterService: class MailDnsWriterService {},
}));
jest.mock('./mail-poll.service', () => ({
  MailPollService: class MailPollService {},
}));
jest.mock('./mail-event-store.service', () => ({
  MailEventStoreService: class MailEventStoreService {},
}));

import { Test } from '@nestjs/testing';
import type {
  DeliveryEvent,
  MailDriver,
  SendRequest,
  SendResult,
} from '@flui-cloud/mail';
import { MailSendService } from './mail-send.service';
import { MailProviderResolver } from './mail-provider.resolver';
import { MailSuppressionService } from './mail-suppression.service';
import { MailDnsWriterService } from './mail-dns-writer.service';
import { MailPollService } from './mail-poll.service';
import { MailEventStoreService } from './mail-event-store.service';

const MESSAGE: SendRequest = {
  from: { email: 'noreply@mail.example.com' },
  to: [{ email: 'someone@example.test' }],
  subject: 'Hello',
  text: 'Body',
};

/**
 * A provider that accepts and then says nothing — which is every webhook
 * provider between the send and the first event, and some of them for ever.
 */
function silentDriver(result: Partial<SendResult> = {}): MailDriver {
  return {
    id: 'brevo',
    capabilities: { transactional: true, bulk: true },
    observability: { channel: 'webhook', reports: ['delivered'] },
    send: async () => ({
      provider: 'brevo',
      messageId: 'mid-1',
      accepted: 1,
      ...result,
    }),
    ensureDomain: async () => ({
      domain: 'mail.example.com',
      verified: true,
      records: [],
    }),
  } as unknown as MailDriver;
}

async function build(driver: MailDriver) {
  const recorded: DeliveryEvent[][] = [];
  const suppressed: DeliveryEvent[][] = [];

  const moduleRef = await Test.createTestingModule({
    providers: [
      MailSendService,
      {
        provide: MailProviderResolver,
        useValue: { driverFor: async () => driver },
      },
      {
        provide: MailSuppressionService,
        useValue: {
          suppressed: async () => [],
          recordEvents: async (events: DeliveryEvent[]) => {
            suppressed.push(events);
          },
        },
      },
      { provide: MailDnsWriterService, useValue: {} },
      { provide: MailPollService, useValue: {} },
      {
        provide: MailEventStoreService,
        useValue: {
          record: async (events: DeliveryEvent[]) => {
            recorded.push(events);
            return events.length;
          },
        },
      },
    ],
  }).compile();

  return { service: moduleRef.get(MailSendService), recorded, suppressed };
}

describe('recording a send the provider has not reported on yet', () => {
  it('writes the message down at acceptance, so it is not invisible', async () => {
    const { service, recorded } = await build(silentDriver());

    await service.send(MESSAGE);

    // Without this the message exists nowhere until its provider reports on
    // it — and a webhook provider may never report at all. A console that
    // shows nothing for a send it just accepted cannot be investigated.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual([
      expect.objectContaining({
        kind: 'queued',
        provider: 'brevo',
        messageId: 'mid-1',
        recipient: 'someone@example.test',
        from: 'noreply@mail.example.com',
        subject: 'Hello',
      }),
    ]);
  });

  it('never suppresses on an acceptance', async () => {
    const { service, suppressed } = await build(silentDriver());

    await service.send(MESSAGE);

    // `queued` is a fact about us handing the message over, not a verdict about
    // the address. Feeding it to the do-not-send list would be a claim nobody
    // made.
    expect(suppressed).toHaveLength(0);
  });

  it('skips a send with no message id rather than storing a row nothing can update', async () => {
    const { service, recorded } = await build(
      silentDriver({ messageId: null }),
    );

    await service.send(MESSAGE);

    // The store keys on provider + message id + recipient. A row with no id
    // could never be moved forward by the verdict that follows, so it would sit
    // as `queued` for ever and read as a stuck message.
    expect(recorded).toHaveLength(0);
  });

  it('leaves a driver that already knows the outcome alone', async () => {
    const settled: DeliveryEvent = {
      kind: 'bounced',
      provider: 'smtp',
      messageId: 'mid-2',
      recipient: 'someone@example.test',
      at: new Date('2026-08-12T10:00:00Z').toISOString(),
      code: 550,
    };
    const { service, recorded, suppressed } = await build(
      silentDriver({ provider: 'smtp', messageId: 'mid-2', events: [settled] }),
    );

    await service.send(MESSAGE);

    // A relay settles every recipient at handover and will never speak again,
    // so its verdict is the only one there will ever be — overwriting it with
    // `queued` would lose the refusal and the suppression that follows from it.
    expect(recorded).toEqual([[settled]]);
    expect(suppressed).toEqual([[settled]]);
  });
});
