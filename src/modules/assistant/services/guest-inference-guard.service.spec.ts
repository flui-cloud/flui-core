import { runWithActorContext } from '../../auth/utils/actor-context';
import {
  GUEST_INFERENCE_CODE,
  GuestInferenceGuardService,
} from './guest-inference-guard.service';
import { guestInferenceLimits } from './guest-inference-limits';

const NOW = new Date('2026-10-19T22:00:00Z');

const memoryThrottler = () => {
  const hits = new Map<string, number>();
  const blocked = new Map<string, number>();
  return {
    increment: jest.fn(
      async (
        key: string,
        ttl: number,
        limit: number,
        blockDuration: number,
      ) => {
        if (blocked.has(key)) {
          return {
            totalHits: hits.get(key) ?? 0,
            timeToExpire: ttl / 1000,
            isBlocked: true,
            timeToBlockExpire: blockDuration / 1000,
          };
        }
        const n = (hits.get(key) ?? 0) + 1;
        hits.set(key, n);
        if (n > limit && blockDuration > 0) blocked.set(key, blockDuration);
        return {
          totalHits: n,
          timeToExpire: ttl / 1000,
          isBlocked: false,
          timeToBlockExpire: 0,
        };
      },
    ),
    blockedSeconds: jest.fn(async (key: string) =>
      Math.ceil((blocked.get(key) ?? 0) / 1000),
    ),
  };
};

const build = (
  env: Record<string, string> = {},
  spend: { instance?: number; address?: number } = {},
) => {
  const usage = {
    guestTotalSince: jest.fn(async () => spend.instance ?? 0),
    tokensForAddress: jest.fn(async () => spend.address ?? 0),
  };
  const throttler = memoryThrottler();
  const guard = new GuestInferenceGuardService(
    {
      limits: async () => guestInferenceLimits((key) => env[key]),
    } as never,
    usage as never,
    throttler as never,
    { deriveSubkey: () => Buffer.from('k') } as never,
    { get: () => undefined } as never,
  );
  return { guard, usage, throttler };
};

const fromAddress = <T>(ip: string, fn: () => Promise<T>) =>
  runWithActorContext(fn, ip);

describe('GuestInferenceGuardService', () => {
  it('lets every guest through and counts nothing when no limit is set', async () => {
    const { guard, usage, throttler } = build();

    await expect(
      fromAddress('203.0.113.7', () => guard.admit('u1', false, NOW)),
    ).resolves.toEqual({ budget: 200_000, ipHash: null });
    expect(throttler.increment).not.toHaveBeenCalled();
    expect(throttler.blockedSeconds).not.toHaveBeenCalled();
    expect(usage.guestTotalSince).not.toHaveBeenCalled();
    expect(usage.tokensForAddress).not.toHaveBeenCalled();
  });

  it('refuses every guest while the switch is off', async () => {
    const { guard } = build({ SANDBOX_INFERENCE_ENABLED: 'false' });

    await expect(guard.admit('u1', false, NOW)).rejects.toMatchObject({
      response: { code: GUEST_INFERENCE_CODE.OFF },
      status: 503,
    });
  });

  describe('visitors', () => {
    it('get the area budget unless a visitor budget is set', async () => {
      expect((await build().guard.admit('v1', true, NOW)).budget).toBe(200_000);
      const { guard } = build({
        SANDBOX_VISITOR_INFERENCE_TOKEN_BUDGET: '20000',
      });
      expect((await guard.admit('v1', true, NOW)).budget).toBe(20_000);
      expect((await guard.admit('g1', false, NOW)).budget).toBe(200_000);
      expect(await guard.budgetFor(true)).toBe(20_000);
    });

    it('are refused outright with a zero budget, guests are not', async () => {
      const { guard } = build({ SANDBOX_VISITOR_INFERENCE_TOKEN_BUDGET: '0' });

      await expect(guard.admit('v1', true, NOW)).rejects.toMatchObject({
        response: { code: GUEST_INFERENCE_CODE.VISITORS_CLOSED },
        status: 403,
      });
      await expect(guard.admit('g1', false, NOW)).resolves.toBeTruthy();
    });
  });

  describe('request rates', () => {
    it('refuses the request past the per-account limit', async () => {
      const { guard } = build({ SANDBOX_INFERENCE_PER_MINUTE: '2' });

      await guard.admit('u1', false, NOW);
      await guard.admit('u1', false, NOW);
      await expect(guard.admit('u1', false, NOW)).rejects.toMatchObject({
        response: { code: GUEST_INFERENCE_CODE.RATE_LIMIT },
        status: 429,
      });
      await expect(guard.admit('u2', false, NOW)).resolves.toBeTruthy();
    });

    it('counts different accounts from one address together', async () => {
      const { guard } = build({ SANDBOX_INFERENCE_PER_IP_HOUR: '2' });
      const ask = (user: string, ip: string) =>
        fromAddress(ip, () => guard.admit(user, false, NOW));

      await ask('u1', '198.51.100.1');
      await ask('u2', '198.51.100.1');
      await expect(ask('u3', '198.51.100.1')).rejects.toMatchObject({
        response: { code: GUEST_INFERENCE_CODE.RATE_LIMIT },
      });
      await expect(ask('u3', '198.51.100.2')).resolves.toBeTruthy();
    });

    it('keys an address by its hash, never the address itself', async () => {
      const { guard, throttler } = build({
        SANDBOX_INFERENCE_PER_IP_MINUTE: '5',
      });

      await fromAddress('198.51.100.1', () => guard.admit('u1', false, NOW));

      const keys = throttler.increment.mock.calls.map((c) => c[0]);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^ip:[0-9a-f]{64}:minute$/);
    });

    it('skips the address limits when the address is unknown', async () => {
      const { guard } = build({ SANDBOX_INFERENCE_PER_IP_MINUTE: '1' });

      await guard.admit('u1', false, NOW);
      await expect(guard.admit('u1', false, NOW)).resolves.toBeTruthy();
    });
  });

  describe('off-topic questions', () => {
    it('pause the assistant for that person once past the hourly count', async () => {
      const { guard } = build({
        SANDBOX_INFERENCE_OFFTOPIC_PER_HOUR: '2',
        SANDBOX_INFERENCE_OFFTOPIC_COOLDOWN_MINUTES: '10',
      });

      await guard.noteOffTopic('u1');
      await guard.noteOffTopic('u1');
      await expect(guard.admit('u1', false, NOW)).resolves.toBeTruthy();
      await guard.noteOffTopic('u1');

      await expect(guard.admit('u1', false, NOW)).rejects.toMatchObject({
        response: {
          code: GUEST_INFERENCE_CODE.OFFTOPIC_COOLDOWN,
          retryAfterSeconds: 600,
        },
        status: 429,
      });
      await expect(guard.admit('u2', false, NOW)).resolves.toBeTruthy();
    });

    it('show the pause, not the rate limit, to someone retrying during it, and do not count the retries', async () => {
      const { guard, throttler } = build({
        SANDBOX_INFERENCE_OFFTOPIC_PER_HOUR: '1',
        SANDBOX_INFERENCE_PER_MINUTE: '2',
      });
      await guard.noteOffTopic('u1');
      await guard.noteOffTopic('u1');
      throttler.increment.mockClear();

      for (let i = 0; i < 4; i++) {
        await expect(guard.admit('u1', false, NOW)).rejects.toMatchObject({
          response: { code: GUEST_INFERENCE_CODE.OFFTOPIC_COOLDOWN },
        });
      }
      expect(throttler.increment).not.toHaveBeenCalled();
    });

    it('are not counted while the limit is unset', async () => {
      const { guard, throttler } = build();

      await guard.noteOffTopic('u1');

      expect(throttler.increment).not.toHaveBeenCalled();
    });
  });

  describe('what a refusal offers', () => {
    it('offers MCP to a signed-in guest and not to a visitor, who has no account for an agent', async () => {
      const env = { SANDBOX_INFERENCE_ENABLED: 'false' };
      await expect(
        build(env).guard.admit('g1', false, NOW),
      ).rejects.toMatchObject({
        response: { message: expect.stringContaining('MCP') },
      });
      const visitor = await build(env)
        .guard.admit('v1', true, NOW)
        .catch((e: { response: { message: string } }) => e.response.message);
      expect(visitor).toContain('Everything else in the demo keeps working.');
      expect(visitor).not.toContain('MCP');
    });
  });

  describe('the instance daily cap', () => {
    it('stops all guests once today’s guest spend reaches it, until midnight UTC', async () => {
      const { guard, usage } = build(
        { SANDBOX_INFERENCE_DAILY_TOKENS: '1000000' },
        { instance: 1_000_000 },
      );

      await expect(guard.admit('u1', false, NOW)).rejects.toMatchObject({
        response: {
          code: GUEST_INFERENCE_CODE.DAILY_CAP,
          retryAfterSeconds: 2 * 3600,
        },
        status: 429,
      });
      expect(usage.guestTotalSince).toHaveBeenCalledWith(
        new Date('2026-10-19T00:00:00Z'),
      );
    });

    it('lets guests through below it', async () => {
      const { guard } = build(
        { SANDBOX_INFERENCE_DAILY_TOKENS: '1000000' },
        { instance: 999_999 },
      );

      await expect(guard.admit('u1', false, NOW)).resolves.toBeTruthy();
    });
  });

  describe('the per-address daily budget', () => {
    it('refuses an address that spent its share in the last 24 hours', async () => {
      const { guard, usage } = build(
        { SANDBOX_INFERENCE_IP_DAILY_TOKENS: '300000' },
        { address: 300_000 },
      );

      await expect(
        fromAddress('198.51.100.1', () => guard.admit('u9', false, NOW)),
      ).rejects.toMatchObject({
        response: { code: GUEST_INFERENCE_CODE.ADDRESS_CAP },
      });
      expect(usage.tokensForAddress).toHaveBeenCalledWith(
        expect.stringMatching(/^[0-9a-f]{64}$/),
        new Date('2026-10-18T22:00:00Z'),
      );
    });

    it('hands the hash to the ledger only while the budget is on', async () => {
      const on = build({ SANDBOX_INFERENCE_IP_DAILY_TOKENS: '300000' });
      const off = build();
      const ask = (g: GuestInferenceGuardService) =>
        fromAddress('198.51.100.1', () => g.admit('u1', false, NOW));

      expect((await ask(on.guard)).ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect((await ask(off.guard)).ipHash).toBeNull();
    });
  });
});
