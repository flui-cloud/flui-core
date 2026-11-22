import { migrations } from './index';
import { DbImports1790000000052 } from './1790000000052-DbImports';

describe('DbImports1790000000052', () => {
  it('only creates its own table and index', async () => {
    const sql: string[] = [];
    await new DbImports1790000000052().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql).toHaveLength(2);
    expect(sql.every((q) => q.includes('IF NOT EXISTS'))).toBe(true);
  });

  it('runs last', () => {
    expect(migrations[migrations.length - 1]).toBe(DbImports1790000000052);
  });
});
