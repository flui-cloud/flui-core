jest.mock('../../mail/services/mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));

import { SandboxWaitlistService } from './sandbox-waitlist.service';
import { loadSandboxConfig } from '../sandbox.config';

type Waiting = {
  id: string;
  userId: string;
  email: string | null;
  offeredAt: Date | null;
  offerExpiresAt: Date | null;
  createdAt: Date;
};

describe('SandboxWaitlistService', () => {
  const NOW = new Date('2026-10-07T12:00:00Z');
  const person = (
    id: string,
    minute: number,
    over: Partial<Waiting> = {},
  ): Waiting => ({
    id,
    userId: `u-${id}`,
    email: `${id}@example.com`,
    offeredAt: null,
    offerExpiresAt: null,
    createdAt: new Date(NOW.getTime() - (60 - minute) * 60_000),
    ...over,
  });

  const build = (waiting: Waiting[], claimed: number, slots = '3') => {
    const mailed: string[] = [];
    const repo = {
      delete: async (where: { offerExpiresAt: { _value: Date } }) => {
        const cut = where.offerExpiresAt._value;
        for (let i = waiting.length - 1; i >= 0; i--) {
          const w = waiting[i];
          if (w.offerExpiresAt && w.offerExpiresAt <= cut) waiting.splice(i, 1);
        }
      },
      count: async () =>
        waiting.filter((w) => w.offerExpiresAt && w.offerExpiresAt > NOW)
          .length,
      find: async ({ take }: { take: number }) =>
        waiting
          .filter((w) => !w.offeredAt)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, take),
      update: async (id: string, set: Partial<Waiting>) =>
        Object.assign(waiting.find((w) => w.id === id)!, set),
    };
    const service = new SandboxWaitlistService(
      repo as never,
      { count: async () => claimed } as never,
      loadSandboxConfig({
        SANDBOX_MAX_SLOTS: slots,
        SANDBOX_WAITLIST_OFFER_HOURS: '2',
      }),
      {
        waitlistOffer: async ({ to }: { to: string }) => {
          mailed.push(to);
          return true;
        },
      } as never,
      { origin: 'https://demo.flui.cloud' } as never,
    );
    return { service, mailed, waiting };
  };

  it('offers each free space to the next person in order of arrival, and mails them', async () => {
    const { service, mailed, waiting } = build(
      [person('b', 2), person('a', 1), person('c', 3)],
      1,
    );

    expect(await service.offerFreedSlots(NOW)).toBe(2);
    expect(mailed).toEqual(['a@example.com', 'b@example.com']);
    const offered = waiting
      .filter((w) => w.offeredAt)
      .map((w) => w.id)
      .sort();
    expect(offered).toEqual(['a', 'b']);
    expect(waiting.find((w) => w.id === 'a')?.offerExpiresAt).toEqual(
      new Date(NOW.getTime() + 2 * 3_600_000),
    );
  });

  it('offers nothing while the spaces are taken or already held by an offer', async () => {
    const { service } = build(
      [
        person('a', 1, {
          offeredAt: NOW,
          offerExpiresAt: new Date(NOW.getTime() + 60_000),
        }),
        person('b', 2),
      ],
      2,
    );

    expect(await service.offerFreedSlots(NOW)).toBe(0);
  });

  it('takes back an offer nobody used, so the space goes to the next person', async () => {
    const { service, mailed, waiting } = build(
      [
        person('a', 1, {
          offeredAt: new Date(0),
          offerExpiresAt: new Date(NOW.getTime() - 1),
        }),
        person('b', 2),
      ],
      2,
    );

    expect(await service.offerFreedSlots(NOW)).toBe(1);
    expect(waiting.map((w) => w.id)).toEqual(['b']);
    expect(mailed).toEqual(['b@example.com']);
  });

  it('never mails an address the identity provider has not proven', async () => {
    const { service, mailed } = build(
      [person('a', 1, { email: 'oidc-1@flui.invalid' })],
      0,
    );

    expect(await service.offerFreedSlots(NOW)).toBe(1);
    expect(mailed).toEqual([]);
  });
});
