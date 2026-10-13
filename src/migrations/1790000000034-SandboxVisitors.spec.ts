import { migrations } from './index';
import { SandboxVisitors1790000000034 } from './1790000000034-SandboxVisitors';

const capture = async (run: (q: never) => Promise<void>) => {
  const sql: string[] = [];
  await run({
    query: async (q: string) => {
      sql.push(q);
    },
  } as never);
  return sql;
};

describe('SandboxVisitors1790000000034', () => {
  it('marks every existing person as a person and indexes the visitor sweep', async () => {
    const sql = await capture((q) => new SandboxVisitors1790000000034().up(q));
    expect(sql[0]).toContain(
      `"kind" character varying(16) NOT NULL DEFAULT 'person'`,
    );
    expect(sql[1]).toContain('ON "users" ("kind", "lastSeenAt")');
  });

  it('removes the visitor row with its person', async () => {
    const sql = await capture((q) => new SandboxVisitors1790000000034().up(q));
    const table = sql.find((q) => q.includes('"sandbox_visitors"'))!;
    expect(table).toContain('PRIMARY KEY ("userId")');
    expect(table).toContain('REFERENCES "users"("id") ON DELETE CASCADE');
    expect(table).not.toMatch(/network/i);
  });

  it('undoes itself in reverse order', async () => {
    const sql = await capture((q) =>
      new SandboxVisitors1790000000034().down(q),
    );
    expect(sql).toEqual([
      'DROP TABLE IF EXISTS "sandbox_visitors"',
      'DROP INDEX IF EXISTS "IDX_users_kind_last_seen"',
      'ALTER TABLE "users" DROP COLUMN IF EXISTS "kind"',
    ]);
  });

  it('runs right after the registry settings', () => {
    const at = migrations.indexOf(SandboxVisitors1790000000034);
    expect(migrations[at - 1].name).toBe('RegistrySettings1790000000033');
  });
});
