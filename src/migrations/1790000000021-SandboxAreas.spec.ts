import { QueryRunner } from 'typeorm';
import { SandboxAreas1790000000021 } from './1790000000021-SandboxAreas';
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

describe('SandboxAreas1790000000021', () => {
  it('lets an area exist without an email and remember its project', async () => {
    const { runner, statements } = recorder();
    await new SandboxAreas1790000000021().up(runner);
    expect(statements).toEqual([
      'ALTER TABLE "sandbox_tenants" ALTER COLUMN "email" DROP NOT NULL',
      'ALTER TABLE "sandbox_tenants" ADD COLUMN IF NOT EXISTS "projectId" uuid',
    ]);
  });

  it('restores the column constraint on the way down', async () => {
    const { runner, statements } = recorder();
    await new SandboxAreas1790000000021().down(runner);
    expect(statements[0]).toBe(
      'ALTER TABLE "sandbox_tenants" DROP COLUMN IF EXISTS "projectId"',
    );
    expect(statements.at(-1)).toBe(
      'ALTER TABLE "sandbox_tenants" ALTER COLUMN "email" SET NOT NULL',
    );
  });

  it('is registered after the project namespaces', () => {
    const at = migrations.indexOf(SandboxAreas1790000000021);
    expect(at).toBeGreaterThan(0);
    expect(migrations[at - 1].name).toBe('ProjectNamespaces1790000000020');
  });
});
