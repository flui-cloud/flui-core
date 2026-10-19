import { InferenceUsageService } from './inference-usage.service';

describe('InferenceUsageService by kind of person', () => {
  const build = (rows: unknown[]) => {
    const sql: string[] = [];
    const qb: Record<string, unknown> = {};
    for (const m of [
      'leftJoin',
      'select',
      'addSelect',
      'groupBy',
      'orderBy',
      'limit',
      'where',
    ]) {
      qb[m] = (...args: unknown[]) => {
        sql.push(args.map(String).join(' '));
        return qb;
      };
    }
    qb.getRawMany = async () => rows;
    const service = new InferenceUsageService({
      createQueryBuilder: () => qb,
    } as never);
    return { service, sql };
  };

  it('adds the spend up for visitors, guests, people and the platform', async () => {
    const t = build([
      { kind: 'visitor', people: '3', calls: '9', tokens: '900' },
      { kind: 'platform', people: '0', calls: '1', tokens: '10' },
    ]);
    expect(await t.service.byKind(new Date(0))).toEqual([
      { kind: 'visitor', people: 3, calls: 9, tokens: 900 },
      { kind: 'platform', people: 0, calls: 1, tokens: 10 },
    ]);
    const text = t.sql.join('\n');
    expect(text).toContain('sv."userId" = u."userId"');
    expect(text).toContain('sv."upgradedAt" IS NULL');
    expect(text).toContain("THEN 'guest' ELSE 'person'");
  });

  it('says of every spender what kind of person it is', async () => {
    const t = build([
      { userId: 'v', guest: true, visitor: true, calls: '1', tokens: '5' },
      { userId: 'g', guest: true, visitor: false, calls: '1', tokens: '4' },
      { userId: 'p', guest: false, visitor: false, calls: '1', tokens: '3' },
      { userId: null, guest: false, visitor: false, calls: '1', tokens: '2' },
    ]);
    expect((await t.service.byPerson()).map((r) => r.kind)).toEqual([
      'visitor',
      'guest',
      'person',
      'platform',
    ]);
  });
});

describe('InferenceUsageService for the guest limits', () => {
  const build = (n: string) => {
    const sql: Array<[string, unknown]> = [];
    const qb: Record<string, unknown> = {};
    for (const m of ['select', 'where', 'andWhere']) {
      qb[m] = (text: string, params?: unknown) => {
        sql.push([text, params]);
        return qb;
      };
    }
    qb.getRawOne = async () => ({ n });
    const update = jest.fn(async () => ({ affected: 3 }));
    const insert = jest.fn(async () => undefined);
    const service = new InferenceUsageService({
      createQueryBuilder: () => qb,
      update,
      insert,
    } as never);
    return { service, sql, update, insert };
  };

  it('adds up only guest spend since the moment given', async () => {
    const since = new Date('2026-10-19T00:00:00Z');
    const t = build('1234');

    expect(await t.service.guestTotalSince(since)).toBe(1234);
    expect(t.sql.map(([q]) => q)).toContain('u.guest = true');
    expect(t.sql).toContainEqual(['u."createdAt" >= :since', { since }]);
  });

  it('adds up the spend behind one address hash', async () => {
    const t = build('77');

    expect(await t.service.tokensForAddress('h1', new Date(0))).toBe(77);
    expect(t.sql).toContainEqual(['u."ipHash" = :ipHash', { ipHash: 'h1' }]);
  });

  it('writes the address hash only when one is given', async () => {
    const t = build('0');
    const row = {
      userId: 'u1',
      guest: true,
      model: 'm',
      endpoint: 'https://p.example/v1',
      surface: 'assistant',
      promptTokens: 1,
      completionTokens: 1,
    };

    await t.service.record(row);
    await t.service.record({ ...row, ipHash: 'h1' });

    const written = t.insert.mock.calls as unknown as Array<
      [{ ipHash: string | null }]
    >;
    expect(written.map(([r]) => r.ipHash)).toEqual([null, 'h1']);
  });

  it('forgets address hashes older than two days', async () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const t = build('0');

    expect(await t.service.forgetAddresses(now)).toBe(3);
    const calls = t.update.mock.calls as unknown as Array<
      [{ createdAt: { value: Date } }, unknown]
    >;
    const [where, set] = calls[0];
    expect(set).toEqual({ ipHash: null });
    expect(where.createdAt.value).toEqual(new Date('2026-10-17T12:00:00Z'));
  });
});
