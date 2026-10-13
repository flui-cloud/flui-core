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
