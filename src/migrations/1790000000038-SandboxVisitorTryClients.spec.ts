import { migrations } from './index';
import { SandboxVisitorTryClients1790000000038 } from './1790000000038-SandboxVisitorTryClients';

const capture = async (run: (q: never) => Promise<void>) => {
  const sql: string[] = [];
  await run({ query: async (q: string) => void sql.push(q) } as never);
  return sql;
};

describe('SandboxVisitorTryClients1790000000038', () => {
  it('keeps both try client ids beside the login-client credential, idempotently', async () => {
    const sql = await capture((q) =>
      new SandboxVisitorTryClients1790000000038().up(q),
    );
    expect(sql).toEqual([
      'ALTER TABLE "sandbox_visitor_login_client" ADD COLUMN IF NOT EXISTS "webClientId" character varying(64)',
      'ALTER TABLE "sandbox_visitor_login_client" ADD COLUMN IF NOT EXISTS "cliClientId" character varying(64)',
    ]);
  });

  it('undoes itself', async () => {
    const sql = await capture((q) =>
      new SandboxVisitorTryClients1790000000038().down(q),
    );
    expect(sql).toHaveLength(2);
    expect(sql.every((q) => q.includes('DROP COLUMN IF EXISTS'))).toBe(true);
  });

  it('runs right after the visitor records', () => {
    const at = migrations.indexOf(SandboxVisitorTryClients1790000000038);
    expect(at).toBeGreaterThan(0);
    expect(migrations[at - 1].name).toBe('SandboxVisitorRecords1790000000037');
  });
});
