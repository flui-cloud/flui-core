import { guestInferenceLimits } from './guest-inference-limits';

describe('guestInferenceLimits', () => {
  const from = (env: Record<string, string>) =>
    guestInferenceLimits((key) => env[key]);

  it('changes nothing when nothing is set: open, area budget only', () => {
    expect(from({})).toEqual({
      enabled: true,
      areaBudget: 200_000,
      visitorBudget: null,
      instanceDailyTokens: null,
      ipDailyTokens: null,
      perMinute: null,
      perHour: null,
      perIpMinute: null,
      perIpHour: null,
      offTopicPerHour: null,
      offTopicCooldownMs: 15 * 60_000,
    });
  });

  it('is switched off only by an explicit false', () => {
    expect(from({ SANDBOX_INFERENCE_ENABLED: 'FALSE' }).enabled).toBe(false);
    expect(from({ SANDBOX_INFERENCE_ENABLED: 'no' }).enabled).toBe(true);
  });

  it('reads every limit, ignoring what is not a positive number', () => {
    const limits = from({
      SANDBOX_INFERENCE_DAILY_TOKENS: '3000000',
      SANDBOX_INFERENCE_IP_DAILY_TOKENS: '400000',
      SANDBOX_INFERENCE_PER_MINUTE: '4',
      SANDBOX_INFERENCE_PER_HOUR: '-1',
      SANDBOX_INFERENCE_PER_IP_MINUTE: 'junk',
      SANDBOX_INFERENCE_PER_IP_HOUR: '0',
      SANDBOX_INFERENCE_OFFTOPIC_PER_HOUR: '5',
      SANDBOX_INFERENCE_OFFTOPIC_COOLDOWN_MINUTES: '30',
    });
    expect(limits).toMatchObject({
      instanceDailyTokens: 3_000_000,
      ipDailyTokens: 400_000,
      perMinute: 4,
      perHour: null,
      perIpMinute: null,
      perIpHour: null,
      offTopicPerHour: 5,
      offTopicCooldownMs: 30 * 60_000,
    });
  });

  it('lets a zero visitor budget close the assistant to visitors', () => {
    expect(
      from({ SANDBOX_VISITOR_INFERENCE_TOKEN_BUDGET: '0' }).visitorBudget,
    ).toBe(0);
    expect(
      from({ SANDBOX_VISITOR_INFERENCE_TOKEN_BUDGET: '' }).visitorBudget,
    ).toBeNull();
  });
});
