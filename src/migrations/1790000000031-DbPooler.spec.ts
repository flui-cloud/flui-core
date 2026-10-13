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
    const at = migrations.indexOf(DbPooler1790000000031);
    expect(migrations[at + 1].name).toBe('DbPoolerCut1790000000032');
  });
});
