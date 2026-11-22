import { migrations } from './index';
import { AppIdentityLinks1790000000048 } from './1790000000048-AppIdentityLinks';

describe('AppIdentityLinks1790000000048', () => {
  it('only creates its own table and indexes', async () => {
    const sql: string[] = [];
    await new AppIdentityLinks1790000000048().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql).toHaveLength(3);
    expect(sql.every((q) => q.includes('IF NOT EXISTS'))).toBe(true);
  });

  it('runs right after the identity email sends migration', () => {
    const at = migrations.indexOf(AppIdentityLinks1790000000048);
    expect(migrations[at - 1].name).toBe('IdentityEmailSends1790000000047');
  });
});
