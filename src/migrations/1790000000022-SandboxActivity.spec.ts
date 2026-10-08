import { QueryRunner } from 'typeorm';
import { SandboxActivity1790000000022 } from './1790000000022-SandboxActivity';
import { migrations } from './index';

function recorder() {
  const statements: string[] = [];
  const runner = {
    query: jest.fn(async (sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return [];
    }),
  };
  return { runner: runner as unknown as QueryRunner, statements };
}

describe('SandboxActivity1790000000022', () => {
  it('only adds nullable columns and a new table, touching no existing row', async () => {
    const { runner, statements } = recorder();
    await new SandboxActivity1790000000022().up(runner);
    expect(statements).toHaveLength(6);
    expect(
      statements
        .slice(0, 5)
        .every((s) => s.includes('ADD COLUMN IF NOT EXISTS')),
    ).toBe(true);
    expect(statements[5]).toContain(
      'CREATE TABLE IF NOT EXISTS "sandbox_waitlist"',
    );
    expect(statements[5]).toContain('UNIQUE ("userId")');
    expect(statements.join(' ')).not.toMatch(
      /UPDATE|DELETE|NOT NULL DEFAULT (?!uuid_generate_v4|now)/,
    );
  });

  it('drops the table first on the way down', async () => {
    const { runner, statements } = recorder();
    await new SandboxActivity1790000000022().down(runner);
    expect(statements[0]).toBe('DROP TABLE IF EXISTS "sandbox_waitlist"');
    expect(statements).toHaveLength(6);
  });

  it('is registered after the sandbox areas', () => {
    const at = migrations.indexOf(SandboxActivity1790000000022);
    expect(migrations[at - 1].name).toBe('SandboxAreas1790000000021');
  });
});
