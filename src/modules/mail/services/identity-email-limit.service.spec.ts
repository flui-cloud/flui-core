import {
  IdentityEmailLimitService,
  identityEmailLimits,
  identityRecipientHash,
} from './identity-email-limit.service';

const NOW = new Date('2026-11-21T12:00:00.000Z');

function build(counts: { recipient: number; hour: number }) {
  const sends = {
    count: jest.fn(async ({ where }: { where: { recipientHash?: string } }) =>
      where.recipientHash ? counts.recipient : counts.hour,
    ),
    insert: jest.fn(),
    delete: jest.fn(),
  };
  return { service: new IdentityEmailLimitService(sends as never), sends };
}

describe('ceilings on sign-in mail', () => {
  it('allows twenty a day to one address and no hourly ceiling by default', () => {
    expect(identityEmailLimits({})).toEqual({
      perRecipientPerDay: 20,
      perHour: 0,
    });
  });

  it('reads both from the environment, ignoring a value that is not a whole number', () => {
    expect(
      identityEmailLimits({
        IDENTITY_EMAIL_MAX_PER_RECIPIENT_PER_DAY: '5',
        IDENTITY_EMAIL_MAX_PER_HOUR: 'many',
      }),
    ).toEqual({ perRecipientPerDay: 5, perHour: 0 });
  });

  it('stops an address once it has had its day', async () => {
    const { service } = build({ recipient: 20, hour: 0 });
    await expect(service.reached('h', NOW)).resolves.toBe('recipient');
  });

  it('stops everything once the hour is full, when a ceiling is set', async () => {
    const { service } = build({ recipient: 1, hour: 200 });
    await expect(
      service.reached('h', NOW, { perRecipientPerDay: 20, perHour: 200 }),
    ).resolves.toBe('hourly');
    await expect(
      service.reached('h', NOW, { perRecipientPerDay: 20, perHour: 0 }),
    ).resolves.toBeNull();
  });

  it('hashes an address the same however it is written, and never as itself', () => {
    const a = identityRecipientHash(' Visitor@Example.com ', 'k');
    expect(a).toBe(identityRecipientHash('visitor@example.com', 'k'));
    expect(a).not.toBe(identityRecipientHash('visitor@example.com', 'other'));
    expect(a).not.toContain('visitor');
  });

  it('forgets a send after a day', async () => {
    const { service, sends } = build({ recipient: 0, hour: 0 });
    await service.purge(NOW);
    const [{ sentAt }] = sends.delete.mock.calls[0];
    expect(sentAt.value).toEqual(new Date('2026-11-20T12:00:00.000Z'));
  });
});
