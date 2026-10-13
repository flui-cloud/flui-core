import { migrations } from './index';
import { IdentityEmail1790000000039 } from './1790000000039-IdentityEmail';

const capture = async (run: (q: never) => Promise<void>) => {
  const sql: string[] = [];
  await run({ query: async (q: string) => void sql.push(q) } as never);
  return sql;
};

describe('IdentityEmail1790000000039', () => {
  it('creates the identity email table and the event category, idempotently', async () => {
    const sql = await capture((q) => new IdentityEmail1790000000039().up(q));
    expect(sql).toHaveLength(4);
    expect(sql[0]).toContain(
      'CREATE TABLE IF NOT EXISTS "identity_email_provider"',
    );
    expect(sql[0]).toContain('"encryptedSigningKey" text');
    expect(sql[0]).not.toMatch(/"signingKey"/);
    expect(sql[1]).toBe(
      'ALTER TABLE "mail_events" ADD COLUMN IF NOT EXISTS "category" character varying(32)',
    );
    expect(sql[2]).toContain(
      'CREATE TABLE IF NOT EXISTS "identity_email_deliveries"',
    );
    expect(sql[2]).toContain('"bodyHash" character varying(64) NOT NULL');
    expect(sql[2]).not.toMatch(/"body"/);
    expect(sql[3]).toContain('CREATE INDEX IF NOT EXISTS');
    expect(sql.join('\n')).not.toMatch(/INSERT/);
  });

  it('undoes only its own changes', async () => {
    const sql = await capture((q) => new IdentityEmail1790000000039().down(q));
    expect(sql).toEqual([
      'DROP TABLE IF EXISTS "identity_email_deliveries"',
      'ALTER TABLE "mail_events" DROP COLUMN IF EXISTS "category"',
      'DROP TABLE IF EXISTS "identity_email_provider"',
    ]);
  });

  it('runs last, after the visitor try clients', () => {
    expect(migrations[migrations.length - 1]).toBe(IdentityEmail1790000000039);
    expect(migrations[migrations.length - 2].name).toBe(
      'SandboxVisitorTryClients1790000000038',
    );
  });
});
