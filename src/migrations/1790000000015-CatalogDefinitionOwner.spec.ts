import { QueryRunner } from 'typeorm';
import { CatalogDefinitionOwner1790000000015 } from './1790000000015-CatalogDefinitionOwner';

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

describe('CatalogDefinitionOwner1790000000015', () => {
  it('adds a nullable owner, leaving every existing row shared, and splits uniqueness by owner', async () => {
    const { runner, statements } = recorder();

    await new CatalogDefinitionOwner1790000000015().up(runner);

    expect(statements).toEqual([
      'ALTER TABLE "catalog_app_definitions" ADD COLUMN IF NOT EXISTS "ownerUserId" uuid',
      'ALTER TABLE "catalog_app_definitions" DROP CONSTRAINT IF EXISTS "UQ_2d1fdde6d0857f5f29b1494d0c8"',
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_catalog_app_definitions_shared_slug_version" ON "catalog_app_definitions" ("slug", "version") WHERE "ownerUserId" IS NULL',
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_catalog_app_definitions_owned_slug_version" ON "catalog_app_definitions" ("ownerUserId", "slug", "version") WHERE "ownerUserId" IS NOT NULL',
    ]);
    expect(statements.join(' ')).not.toMatch(/UPDATE|DELETE/);
  });

  it('is registered with the migrations the API runs on boot', async () => {
    const { migrations } = await import('./index');
    expect(migrations).toContain(CatalogDefinitionOwner1790000000015);
  });
});
