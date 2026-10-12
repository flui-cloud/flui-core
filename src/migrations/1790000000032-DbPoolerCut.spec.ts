import { migrations } from './index';
import { DbPoolerCut1790000000032 } from './1790000000032-DbPoolerCut';

describe('DbPoolerCut1790000000032', () => {
  it('adds the pooler cut as a nullable column and the three pooler steps', async () => {
    const sql: string[] = [];
    await new DbPoolerCut1790000000032().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql).toContain(
      'ALTER TABLE "db_migrations" ADD COLUMN IF NOT EXISTS "poolerCut" jsonb',
    );
    expect(sql.join('\n')).not.toMatch(/NOT NULL|DEFAULT/);
    for (const step of [
      'full_migrate_pooler_forward',
      'db_migrate_pooler_pause',
      'db_migrate_pooler_resume',
    ]) {
      expect(
        sql.some((q) => q.includes(`ADD VALUE IF NOT EXISTS '${step}'`)),
      ).toBe(true);
    }
  });

  it('runs last', () => {
    expect(migrations[migrations.length - 1]).toBe(DbPoolerCut1790000000032);
  });
});
