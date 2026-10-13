import { VisitorRefusalsService } from './visitor-refusals.service';

describe('VisitorRefusalsService', () => {
  const build = (rows: Array<{ reason: string; count: number }> = []) => {
    const repo = {
      query: jest.fn(async () => undefined),
      find: jest.fn(async () => rows),
      delete: jest.fn(async () => ({ affected: 3 })),
    };
    return { service: new VisitorRefusalsService(repo as never), repo };
  };

  it('counts a refusal in its hour', async () => {
    const t = build();
    await t.service.note('limit-ip', new Date('2026-10-13T12:34:56Z'));
    const [sql, params] = t.repo.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain('ON CONFLICT ("hour", "reason")');
    expect(params).toEqual([new Date('2026-10-13T12:00:00Z'), 'limit-ip']);
  });

  it('never throws when the count cannot be written', async () => {
    const t = build();
    t.repo.query.mockRejectedValueOnce(new Error('db down'));
    await expect(t.service.note('error')).resolves.toBeUndefined();
  });

  it('adds the hours up by reason, largest first', async () => {
    const t = build([
      { reason: 'limit-ip', count: 2 },
      { reason: 'challenge', count: 1 },
      { reason: 'limit-ip', count: 3 },
    ]);
    expect(await t.service.since(new Date(0))).toEqual([
      { reason: 'limit-ip', count: 5 },
      { reason: 'challenge', count: 1 },
    ]);
  });

  it('forgets counts older than a week', async () => {
    const t = build();
    expect(await t.service.purge(new Date('2026-10-13T00:00:00Z'))).toBe(3);
  });
});
