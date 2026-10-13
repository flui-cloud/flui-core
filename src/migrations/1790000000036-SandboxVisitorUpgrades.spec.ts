import { migrations } from './index';
import { SandboxVisitorUpgrades1790000000036 } from './1790000000036-SandboxVisitorUpgrades';

const capture = async (run: (q: never) => Promise<void>) => {
  const sql: string[] = [];
  await run({ query: async (q: string) => void sql.push(q) } as never);
  return sql;
};

describe('SandboxVisitorUpgrades1790000000036', () => {
  it('lets the visitor row outlive a visitor merged into an account', async () => {
    const sql = await capture((q) =>
      new SandboxVisitorUpgrades1790000000036().up(q),
    );
    expect(sql[0]).toBe(
      'ALTER TABLE "sandbox_visitors" DROP CONSTRAINT IF EXISTS "FK_d1c8fde693070ee4286565f3b29"',
    );
    const joined = sql.join('\n');
    expect(joined).toContain(
      'FOREIGN KEY ("linkedUserId") REFERENCES "users"("id") ON DELETE SET NULL',
    );
    expect(joined).toContain('ON "sandbox_visitors" ("linkedUserId")');
    expect(joined).toContain('ON "sandbox_visitors" ("idpUserId")');
  });

  it('clears dangling links before the foreign key is added', async () => {
    const sql = await capture((q) =>
      new SandboxVisitorUpgrades1790000000036().up(q),
    );
    const clear = sql.findIndex((q) =>
      q.startsWith('UPDATE "sandbox_visitors"'),
    );
    const fk = sql.findIndex((q) =>
      q.includes('FK_c96495d16f902e292d57b4055c9'),
    );
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(fk);
  });

  it('keeps upgrade handles only as hashes, single use per secret and intent', async () => {
    const joined = (
      await capture((q) => new SandboxVisitorUpgrades1790000000036().up(q))
    ).join('\n');
    expect(joined).toContain('"sandbox_visitor_upgrades"');
    expect(joined).toContain('"secretHash" character varying(64)');
    expect(joined).toContain('"intentTokenEncrypted" text');
    expect(joined).toMatch(
      /UNIQUE INDEX IF NOT EXISTS "IDX_sandbox_visitor_upgrades_secret" .*WHERE "secretHash" IS NOT NULL/,
    );
    expect(joined).toMatch(
      /UNIQUE INDEX IF NOT EXISTS "IDX_sandbox_visitor_upgrades_intent" .*WHERE "intentId" IS NOT NULL/,
    );
    expect(joined).not.toMatch(/"(nonce|token|secret)" /);
  });

  it('undoes itself, dropping orphaned history before restoring the cascade', async () => {
    const sql = await capture((q) =>
      new SandboxVisitorUpgrades1790000000036().down(q),
    );
    expect(sql[0]).toBe('DROP TABLE IF EXISTS "sandbox_visitor_upgrades"');
    expect(sql[sql.length - 2]).toContain('DELETE FROM "sandbox_visitors"');
    expect(sql[sql.length - 1]).toContain('ON DELETE CASCADE');
  });

  it('adds the foreign key only when it is missing, so it can run twice', async () => {
    const sql = await capture((q) =>
      new SandboxVisitorUpgrades1790000000036().up(q),
    );
    const fk = sql.find((q) => q.includes('ADD CONSTRAINT'));
    expect(fk).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_c96495d16f902e292d57b4055c9')",
    );
  });

  it('runs right after the entrance', () => {
    const at = migrations.indexOf(SandboxVisitorUpgrades1790000000036);
    expect(at).toBeGreaterThan(0);
    expect(migrations[at - 1].name).toBe('SandboxVisitorEntrance1790000000035');
  });
});
