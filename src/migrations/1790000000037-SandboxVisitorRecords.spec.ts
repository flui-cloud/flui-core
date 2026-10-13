import { migrations } from './index';
import { SandboxVisitorRecords1790000000037 } from './1790000000037-SandboxVisitorRecords';

const capture = async (run: (q: never) => Promise<void>) => {
  const sql: string[] = [];
  await run({ query: async (q: string) => void sql.push(q) } as never);
  return sql;
};

describe('SandboxVisitorRecords1790000000037', () => {
  it('keeps a removed visitor as a record and counts refusals', async () => {
    const joined = (
      await capture((q) => new SandboxVisitorRecords1790000000037().up(q))
    ).join('\n');
    expect(joined).toContain(
      'ALTER TABLE "sandbox_visitors" ADD COLUMN IF NOT EXISTS "removedAt"',
    );
    expect(joined).toContain('ON "sandbox_visitors" ("createdAt")');
    expect(joined).toContain('ADD COLUMN IF NOT EXISTS "tokenId"');
    expect(joined).toContain('ADD COLUMN IF NOT EXISTS "expiresAt"');
    expect(joined).toContain(
      'CONSTRAINT "PK_sandbox_visitor_refusals" PRIMARY KEY ("hour", "reason")',
    );
    expect(joined).toContain(
      'DELETE FROM "sandbox_visitor_pool" WHERE "takenAt" IS NOT NULL',
    );
  });

  it('only adds: every statement can run twice', async () => {
    const sql = await capture((q) =>
      new SandboxVisitorRecords1790000000037().up(q),
    );
    for (const q of sql.filter((s) => !s.startsWith('DELETE'))) {
      expect(q).toMatch(/IF NOT EXISTS/);
    }
  });

  it('undoes itself', async () => {
    const sql = await capture((q) =>
      new SandboxVisitorRecords1790000000037().down(q),
    );
    expect(sql[0]).toBe('DROP TABLE IF EXISTS "sandbox_visitor_refusals"');
    expect(sql[sql.length - 1]).toBe(
      'ALTER TABLE "sandbox_visitors" DROP COLUMN IF EXISTS "removedAt"',
    );
  });

  it('runs after the upgrades', () => {
    const at = migrations.indexOf(SandboxVisitorRecords1790000000037);
    expect(migrations[at - 1].name).toBe('SandboxVisitorUpgrades1790000000036');
  });
});
