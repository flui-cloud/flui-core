import { migrations } from './index';
import { SandboxVisitorEntrance1790000000035 } from './1790000000035-SandboxVisitorEntrance';

const capture = async (run: (q: never) => Promise<void>) => {
  const sql: string[] = [];
  await run({ query: async (q: string) => void sql.push(q) } as never);
  return sql;
};

describe('SandboxVisitorEntrance1790000000035', () => {
  it('creates the pool, the tickets and the login credential tables', async () => {
    const sql = (
      await capture((q) => new SandboxVisitorEntrance1790000000035().up(q))
    ).join('\n');
    expect(sql).toContain('"sandbox_visitor_pool"');
    expect(sql).toContain('"sessionTokenEncrypted" text NOT NULL');
    expect(sql).toContain('"sandbox_visitor_admissions"');
    expect(sql).toContain('PRIMARY KEY ("nonceHash")');
    expect(sql).toContain('"sandbox_visitor_login_client"');
    expect(sql).toContain('"patEncrypted" text NOT NULL');
    expect(sql).not.toMatch(/"ip"\s/);
  });

  it('undoes itself', async () => {
    expect(
      await capture((q) => new SandboxVisitorEntrance1790000000035().down(q)),
    ).toEqual([
      'DROP TABLE IF EXISTS "sandbox_visitor_login_client"',
      'DROP TABLE IF EXISTS "sandbox_visitor_admissions"',
      'DROP TABLE IF EXISTS "sandbox_visitor_pool"',
    ]);
  });

  it('runs right after the visitors', () => {
    const at = migrations.indexOf(SandboxVisitorEntrance1790000000035);
    expect(migrations[at - 1].name).toBe('SandboxVisitors1790000000034');
  });
});
