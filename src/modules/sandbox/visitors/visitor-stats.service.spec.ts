import { VisitorStatsService } from './visitor-stats.service';
import { loadVisitorConfig } from './visitor.config';

describe('VisitorStatsService', () => {
  it('adds up the entrance: now, ready, the last day and who became an account', async () => {
    const selects: string[] = [];
    let params: Record<string, unknown> = {};
    const qb = {
      leftJoin: () => qb,
      select: (s: string) => (selects.push(s), qb),
      addSelect: (s: string) => (selects.push(s), qb),
      setParameter: (k: string, v: unknown) => ((params = { [k]: v }), qb),
      getRawOne: async () => ({ created: '7', upgraded: '2', merged: '1' }),
    };
    const users = { count: jest.fn(async () => 4) };
    const service = new VisitorStatsService(
      loadVisitorConfig({
        SANDBOX_ENABLED: 'true',
        SANDBOX_VISITORS_ENABLED: 'true',
        SANDBOX_VISITOR_POOL_MIN: '3',
      }),
      { createQueryBuilder: () => qb } as never,
      users as never,
      { ready: async () => 2 } as never,
      {
        since: async () => [
          { reason: 'limit-ip', count: 5 },
          { reason: 'challenge', count: 1 },
        ],
      } as never,
    );
    const now = new Date('2026-10-13T12:00:00Z');

    expect(await service.stats(now)).toEqual({
      entranceOpen: true,
      visitorsNow: 4,
      poolReady: 2,
      poolMin: 3,
      upgraded: 2,
      merged: 1,
      last24h: {
        created: 7,
        refused: 6,
        refusedByReason: [
          { reason: 'limit-ip', count: 5 },
          { reason: 'challenge', count: 1 },
        ],
      },
    });
    expect(users.count).toHaveBeenCalledWith({ where: { kind: 'visitor' } });
    expect(params.since).toEqual(new Date('2026-10-12T12:00:00Z'));
    expect(selects.join(' ')).toContain('u."id" IS NULL');
  });
});
