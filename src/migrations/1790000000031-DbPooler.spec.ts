import { migrations } from './index';
import { DbPooler1790000000031 } from './1790000000031-DbPooler';

describe('DbPooler1790000000031', () => {
  it('adds the pooler as a nullable column, so every existing install reads as no pooler', async () => {
    const sql: string[] = [];
    await new DbPooler1790000000031().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql).toContain(
      'ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "pooler" jsonb',
    );
    expect(sql.join('\n')).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it('runs right before the pooler cut', () => {
    expect(migrations[migrations.length - 2]).toBe(DbPooler1790000000031);
  });
});
