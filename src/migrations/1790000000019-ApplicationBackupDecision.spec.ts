import { QueryRunner } from 'typeorm';
import { ApplicationBackupDecision1790000000019 } from './1790000000019-ApplicationBackupDecision';
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

describe('ApplicationBackupDecision1790000000019', () => {
  it('adds a nullable decision, leaving every existing application asked for', async () => {
    const { runner, statements } = recorder();
    await new ApplicationBackupDecision1790000000019().up(runner);
    expect(statements).toEqual([
      'ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "backupDecision" jsonb',
    ]);
    expect(statements.join(' ')).not.toMatch(/UPDATE|DELETE|DEFAULT/);
  });

  it('drops only that column on the way down', async () => {
    const { runner, statements } = recorder();
    await new ApplicationBackupDecision1790000000019().down(runner);
    expect(statements).toEqual([
      'ALTER TABLE "applications" DROP COLUMN IF EXISTS "backupDecision"',
    ]);
  });

  it('is registered after the removal of the cluster backup engine', () => {
    const at = migrations.indexOf(ApplicationBackupDecision1790000000019);
    expect(at).toBeGreaterThan(0);
    expect(migrations[at - 1].name).toBe(
      'RemoveClusterBackupEngine1790000000018',
    );
  });
});
