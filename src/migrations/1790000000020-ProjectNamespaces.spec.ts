import { QueryRunner } from 'typeorm';
import { ProjectNamespaces1790000000020 } from './1790000000020-ProjectNamespaces';
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

describe('ProjectNamespaces1790000000020', () => {
  it('adds a personal owner, one personal project per person, and the project of an install', async () => {
    const { runner, statements } = recorder();
    await new ProjectNamespaces1790000000020().up(runner);
    expect(statements).toEqual([
      'ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "ownerUserId" uuid',
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_projects_personal_owner" ON "projects" ("ownerUserId") WHERE "ownerUserId" IS NOT NULL',
      'ALTER TABLE "catalog_installs" ADD COLUMN IF NOT EXISTS "projectId" uuid',
    ]);
    expect(statements.join(' ')).not.toMatch(/UPDATE|DELETE|DEFAULT/);
  });

  it('drops exactly what it added on the way down', async () => {
    const { runner, statements } = recorder();
    await new ProjectNamespaces1790000000020().down(runner);
    expect(statements).toEqual([
      'ALTER TABLE "catalog_installs" DROP COLUMN IF EXISTS "projectId"',
      'DROP INDEX IF EXISTS "UQ_projects_personal_owner"',
      'ALTER TABLE "projects" DROP COLUMN IF EXISTS "ownerUserId"',
    ]);
  });

  it('is registered after the backup decision', () => {
    const at = migrations.indexOf(ProjectNamespaces1790000000020);
    expect(at).toBeGreaterThan(0);
    expect(migrations[at - 1].name).toBe(
      'ApplicationBackupDecision1790000000019',
    );
  });
});
