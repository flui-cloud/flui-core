jest.mock('../../mail/services/mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));
jest.mock('@kubernetes/client-node', () => ({}));

import {
  DEFAULT_SPEND_THRESHOLDS,
  guestSpendThresholds,
  InferenceSpendAlertService,
  spendThresholds,
} from './inference-spend-alert.service';

describe('spendThresholds', () => {
  it('defaults to five, twenty and fifty million tokens a day', () => {
    expect(spendThresholds(undefined)).toEqual(DEFAULT_SPEND_THRESHOLDS);
  });

  it('reads a list, sorted, ignoring what is not a positive number', () => {
    expect(spendThresholds('2000000, 1000000,junk,-5,1000000')).toEqual([
      1_000_000, 2_000_000,
    ]);
  });

  it('can be turned off', () => {
    expect(spendThresholds('off')).toEqual([]);
  });
});

describe('guestSpendThresholds', () => {
  it('sends nothing unless the operator names a threshold', () => {
    expect(guestSpendThresholds(undefined)).toEqual([]);
    expect(guestSpendThresholds('')).toEqual([]);
  });

  it('reads the same list format as the instance thresholds', () => {
    expect(guestSpendThresholds('3000000,1000000')).toEqual([
      1_000_000, 3_000_000,
    ]);
  });
});

describe('InferenceSpendAlertService', () => {
  const NOW = new Date('2026-10-07T15:00:00Z');

  const build = (spent: number, guestSpent = 0) => {
    const seen = new Set<string>();
    const alerts = {
      record: jest.fn(async (batch: Array<{ fingerprint: string }>) =>
        batch.flatMap((a) => {
          if (seen.has(a.fingerprint)) return [];
          seen.add(a.fingerprint);
          return [{ kind: 'fired', event: { fingerprint: a.fingerprint } }];
        }),
      ),
    };
    const mail = { deliver: jest.fn(async () => true) };
    const usage = {
      totalSince: jest.fn(async () => spent),
      guestTotalSince: jest.fn(async () => guestSpent),
    };
    const service = new InferenceSpendAlertService(
      usage as never,
      alerts as never,
      mail as never,
    );
    return { service, alerts, mail, usage };
  };

  afterEach(() => {
    delete process.env.INFERENCE_SPEND_ALERT_DAILY_TOKENS;
    delete process.env.SANDBOX_INFERENCE_ALERT_DAILY_TOKENS;
  });

  it('does not read guest spend while no guest threshold is set', async () => {
    const { service, usage } = build(0, 9_000_000);

    expect(await service.check(NOW)).toBe(0);
    expect(usage.guestTotalSince).not.toHaveBeenCalled();
  });

  it('mails about guest spend apart from the instance total', async () => {
    process.env.INFERENCE_SPEND_ALERT_DAILY_TOKENS = 'off';
    process.env.SANDBOX_INFERENCE_ALERT_DAILY_TOKENS = '1000000';
    const { service, alerts } = build(0, 1_500_000);

    expect(await service.check(NOW)).toBe(1);
    expect(alerts.record.mock.calls[0][0][0]).toMatchObject({
      fingerprint: 'inference-guest-spend-2026-10-07-1000000',
      alertname: InferenceSpendAlertService.GUEST_ALERTNAME,
    });
  });

  it('mails once for every threshold the day has crossed, and only once', async () => {
    const { service, mail } = build(21_000_000);

    expect(await service.check(NOW)).toBe(2);
    expect(await service.check(NOW)).toBe(0);
    expect(mail.deliver).toHaveBeenCalledWith('fired', expect.anything(), {
      adminWarnings: true,
    });
  });

  it('counts from the start of the day', async () => {
    const { service, usage } = build(0);

    await service.check(NOW);

    expect(usage.totalSince).toHaveBeenCalledWith(
      new Date('2026-10-07T00:00:00Z'),
    );
  });

  it('sends nothing below the first threshold', async () => {
    const { service, alerts } = build(4_999_999);

    expect(await service.check(NOW)).toBe(0);
    expect(alerts.record).not.toHaveBeenCalled();
  });

  it('keys each day apart, so tomorrow mails again', async () => {
    const { service, alerts } = build(6_000_000);

    await service.check(NOW);
    await service.check(new Date('2026-10-08T01:00:00Z'));

    const fingerprints = alerts.record.mock.calls.map(
      (c) => c[0][0].fingerprint,
    );
    expect(fingerprints).toEqual([
      'inference-spend-2026-10-07-5000000',
      'inference-spend-2026-10-08-5000000',
    ]);
  });

  it('does nothing when the operator turned it off', async () => {
    process.env.INFERENCE_SPEND_ALERT_DAILY_TOKENS = 'off';
    const { service, usage } = build(99_000_000);

    expect(await service.check(NOW)).toBe(0);
    expect(usage.totalSince).not.toHaveBeenCalled();
  });
});
