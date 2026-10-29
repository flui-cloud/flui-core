import { migrations } from './index';
import { DatabaseHa1790000000045 } from './1790000000045-DatabaseHa';

describe('DatabaseHa1790000000045', () => {
  it('adds the highly available state as a nullable column, so every existing database reads as a single instance', async () => {
    const sql: string[] = [];
    await new DatabaseHa1790000000045().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql[0]).toBe(
      'ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "databaseHa" jsonb',
    );
    expect(sql.join('\n')).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it('runs after the cached-token column', () => {
    const at = migrations.indexOf(DatabaseHa1790000000045);
    expect(migrations[at - 1].name).toBe(
      'InferenceUsageCachedTokens1790000000044',
    );
  });
});
