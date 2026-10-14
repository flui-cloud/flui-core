import { migrations } from './index';
import { IdentityConsoleState1790000000040 } from './1790000000040-IdentityConsoleState';

const capture = async (run: (q: never) => Promise<void>) => {
  const sql: string[] = [];
  await run({ query: async (q: string) => void sql.push(q) } as never);
  return sql;
};

describe('IdentityConsoleState1790000000040', () => {
  it('creates the console state table idempotently and seeds nothing, so a fresh install reads closed', async () => {
    const sql = await capture((q) =>
      new IdentityConsoleState1790000000040().up(q),
    );
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain(
      'CREATE TABLE IF NOT EXISTS "identity_console_state"',
    );
    expect(sql[0]).toContain('"openUntil" TIMESTAMP WITH TIME ZONE');
    expect(sql.join('\n')).not.toMatch(/INSERT/);
  });

  it('undoes only its own change', async () => {
    const sql = await capture((q) =>
      new IdentityConsoleState1790000000040().down(q),
    );
    expect(sql).toEqual(['DROP TABLE IF EXISTS "identity_console_state"']);
  });

  it('runs last, after the identity email', () => {
    expect(migrations[migrations.length - 1]).toBe(
      IdentityConsoleState1790000000040,
    );
    expect(migrations[migrations.length - 2].name).toBe(
      'IdentityEmail1790000000039',
    );
  });
});
