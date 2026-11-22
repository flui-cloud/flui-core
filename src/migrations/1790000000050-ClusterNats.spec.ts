import { migrations } from './index';
import { ClusterNats1790000000050 } from './1790000000050-ClusterNats';

describe('ClusterNats1790000000050', () => {
  it('only creates its own tables and indexes', async () => {
    const sql: string[] = [];
    await new ClusterNats1790000000050().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql).toHaveLength(4);
    expect(sql.every((q) => q.includes('IF NOT EXISTS'))).toBe(true);
  });

  it('is registered', () => {
    expect(migrations).toContain(ClusterNats1790000000050);
  });
});
