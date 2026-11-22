import { migrations } from './index';
import { ReplicatedVolumes1790000000046 } from './1790000000046-ReplicatedVolumes';

describe('ReplicatedVolumes1790000000046', () => {
  it('only adds enum values, so no existing row changes', async () => {
    const sql: string[] = [];
    await new ReplicatedVolumes1790000000046().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql).toHaveLength(4);
    expect(sql.every((q) => q.includes('ADD VALUE IF NOT EXISTS'))).toBe(true);
  });

  it('runs right after the database HA migration', () => {
    const at = migrations.indexOf(ReplicatedVolumes1790000000046);
    expect(migrations[at - 1].name).toBe('DatabaseHa1790000000045');
  });
});
