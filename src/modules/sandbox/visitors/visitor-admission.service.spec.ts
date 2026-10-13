import { createHash } from 'node:crypto';
import { VisitorAdmissionService } from './visitor-admission.service';
import { loadVisitorConfig } from './visitor.config';

const OPEN = { SANDBOX_ENABLED: 'true', SANDBOX_VISITORS_ENABLED: 'true' };

describe('VisitorAdmissionService', () => {
  const build = (
    env: Record<string, string> = OPEN,
    fetchSuccess = true,
    madeToday = 0,
  ) => {
    const inserted: Array<Record<string, unknown>> = [];
    const hits = new Map<string, number>();
    const throttler = {
      increment: jest.fn(async (key: string) => {
        hits.set(key, (hits.get(key) ?? 0) + 1);
        return {
          totalHits: hits.get(key)!,
          timeToExpire: 1,
          isBlocked: false,
          timeToBlockExpire: 0,
        };
      }),
    };
    let deleted: { where: unknown[]; raw: unknown[] } = { where: [], raw: [] };
    const qb = {
      delete: () => qb,
      where: (...a: unknown[]) => (deleted.where.push(a), qb),
      andWhere: (...a: unknown[]) => (deleted.where.push(a), qb),
      returning: () => qb,
      execute: async () => ({ raw: deleted.raw }),
    };
    const repo = {
      insert: jest.fn(async (row: Record<string, unknown>) =>
        inserted.push(row),
      ),
      createQueryBuilder: () => qb,
      delete: jest.fn(async () => ({ affected: 2 })),
    };
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ success: fetchSuccess }),
    }));
    const visitors = { count: jest.fn(async () => madeToday) };
    const refusals = { note: jest.fn(async () => undefined) };
    const service = new VisitorAdmissionService(
      loadVisitorConfig(env),
      repo as never,
      { deriveSubkey: () => Buffer.from('k') } as never,
      throttler as never,
      fetchImpl as never,
      visitors as never,
      refusals as never,
    );
    return {
      service,
      visitors,
      refusals,
      inserted,
      fetchImpl,
      throttler,
      setRaw: (raw: unknown[]) => (deleted = { where: [], raw }),
      lastWhere: () => deleted.where,
    };
  };

  it('is closed while the entrance is shut', async () => {
    await expect(
      build({}).service.admit({ ip: '1.2.3.4' }),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'SANDBOX_VISITORS_CLOSED' },
    });
  });

  it('hands out a single-use ticket kept only as its hash, with the address hashed', async () => {
    const { service, inserted } = build();
    const { nonce, expiresInSeconds } = await service.admit({ ip: '1.2.3.4' });
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresInSeconds).toBe(120);
    expect(inserted[0].nonceHash).toBe(
      createHash('sha256').update(nonce).digest('hex'),
    );
    expect(inserted[0].ipHash).toBe(service.hashIp('1.2.3.4'));
    expect(JSON.stringify(inserted[0])).not.toContain('1.2.3.4');
    expect(inserted[0].cli).toBe(false);
  });

  it('refuses an address past its hourly count', async () => {
    const { service, inserted } = build({
      ...OPEN,
      SANDBOX_VISITORS_PER_IP_HOUR: '2',
    });
    await service.admit({ ip: '1.2.3.4' });
    await service.admit({ ip: '1.2.3.4' });
    await expect(service.admit({ ip: '1.2.3.4' })).rejects.toMatchObject({
      status: 429,
      response: { code: 'SANDBOX_VISITORS_LIMIT' },
    });
    await service.admit({ ip: '5.6.7.8' });
    expect(inserted).toHaveLength(3);
  });

  it('refuses everyone past the instance-wide count per minute', async () => {
    const { service } = build({
      ...OPEN,
      SANDBOX_VISITORS_GLOBAL_PER_MINUTE: '1',
    });
    await service.admit({ ip: '1.1.1.1' });
    await expect(service.admit({ ip: '2.2.2.2' })).rejects.toMatchObject({
      status: 429,
    });
  });

  it('asks Cloudflare when it has a secret, and refuses a browser without a passing token', async () => {
    const env = { ...OPEN, TURNSTILE_SECRET_KEY: 'secret' };
    const ok = build(env);
    await expect(ok.service.admit({ ip: '1.2.3.4' })).rejects.toMatchObject({
      status: 403,
      response: { code: 'SANDBOX_VISITOR_CHALLENGE_FAILED' },
    });
    await ok.service.admit({ ip: '1.2.3.4', turnstileToken: 'tok' });
    expect(ok.fetchImpl).toHaveBeenCalledTimes(1);

    const failing = build(env, false);
    await expect(
      failing.service.admit({ ip: '1.2.3.4', turnstileToken: 'tok' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets the command line in without a browser check, under the same counts and one of its own', async () => {
    const { service, inserted, fetchImpl, throttler } = build({
      ...OPEN,
      TURNSTILE_SECRET_KEY: 'secret',
    });
    await service.admit({ ip: '1.2.3.4', cli: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(inserted[0].cli).toBe(true);
    expect(throttler.increment).toHaveBeenCalledTimes(3);
    const keys = throttler.increment.mock.calls.map((c) => c[0]);
    expect(keys.some((k) => k.startsWith('cli-ip:'))).toBe(true);
  });

  it('gives the command line a smaller allowance per address than the browser', async () => {
    const { service, refusals } = build();
    for (let i = 0; i < 3; i++)
      await service.admit({ ip: '1.2.3.4', cli: true });
    await expect(
      service.admit({ ip: '1.2.3.4', cli: true }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'SANDBOX_VISITORS_LIMIT' },
    });
    expect(refusals.note).toHaveBeenCalledWith('limit-cli');
    await service.admit({ ip: '1.2.3.4' });
  });

  it('refuses everyone once the day’s visitors are made', async () => {
    const { service, refusals, visitors, inserted } = build(
      { ...OPEN, SANDBOX_VISITORS_GLOBAL_PER_DAY: '5' },
      true,
      5,
    );
    await expect(service.admit({ ip: '1.2.3.4' })).rejects.toMatchObject({
      status: 429,
    });
    expect(refusals.note).toHaveBeenCalledWith('limit-day');
    expect(inserted).toHaveLength(0);
    const where = JSON.stringify(visitors.count.mock.calls[0]);
    expect(where).toContain('createdAt');
  });

  it('counts every refusal by its reason', async () => {
    const closed = build({});
    await expect(closed.service.admit({ ip: '1' })).rejects.toBeDefined();
    expect(closed.refusals.note).toHaveBeenCalledWith('closed');

    const ip = build({ ...OPEN, SANDBOX_VISITORS_PER_IP_HOUR: '1' });
    await ip.service.admit({ ip: '1' });
    await expect(ip.service.admit({ ip: '1' })).rejects.toBeDefined();
    expect(ip.refusals.note).toHaveBeenCalledWith('limit-ip');

    const challenge = build({ ...OPEN, TURNSTILE_SECRET_KEY: 's' });
    await expect(challenge.service.admit({ ip: '1' })).rejects.toBeDefined();
    expect(challenge.refusals.note).toHaveBeenCalledWith('challenge');
  });

  it('skips the browser check without a secret', async () => {
    const { service, fetchImpl } = build();
    await service.admit({ ip: '1.2.3.4' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('takes a ticket once, only unexpired and only for its own client', async () => {
    const { service, setRaw, lastWhere } = build();
    setRaw([{ ipHash: 'h' }]);
    expect(await service.consume('nonce', false)).toEqual({ ipHash: 'h' });
    const where = JSON.stringify(lastWhere());
    expect(where).toContain(createHash('sha256').update('nonce').digest('hex'));
    expect(where).toContain('expiresAt');
    expect(where).toContain('"cli":false');
    setRaw([]);
    expect(await service.consume('nonce', false)).toBeNull();
    expect(await service.consume(null, false)).toBeNull();
    expect(await service.consume('x'.repeat(200), false)).toBeNull();
  });
});
