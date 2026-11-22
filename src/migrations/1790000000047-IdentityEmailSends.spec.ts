import { migrations } from './index';
import { IdentityEmailSends1790000000047 } from './1790000000047-IdentityEmailSends';

describe('IdentityEmailSends1790000000047', () => {
  it('only creates its own table and indexes', async () => {
    const sql: string[] = [];
    await new IdentityEmailSends1790000000047().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql).toHaveLength(3);
    expect(sql.every((q) => q.includes('IF NOT EXISTS'))).toBe(true);
    expect(sql.join(' ')).toContain('"identity_email_sends"');
  });

  it('runs right after the replicated volumes migration', () => {
    const at = migrations.indexOf(IdentityEmailSends1790000000047);
    expect(migrations[at - 1].name).toBe('ReplicatedVolumes1790000000046');
  });
});
