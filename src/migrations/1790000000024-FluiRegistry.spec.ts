import { QueryRunner } from 'typeorm';
import { FluiRegistry1790000000024 } from './1790000000024-FluiRegistry';
import { migrations } from './index';

describe('FluiRegistry1790000000024', () => {
  const run = async (direction: 'up' | 'down') => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [];
      }),
    } as unknown as QueryRunner;
    await new FluiRegistry1790000000024()[direction](runner);
    return statements;
  };

  it('allows one active signing key and drops credentials with their application', async () => {
    const up = await run('up');
    expect(up.join('\n')).toContain(
      'ON "registry_signing_keys" ("active") WHERE "active"',
    );
    expect(up.join('\n')).toContain(
      'REFERENCES "applications"("id") ON DELETE CASCADE',
    );
  });

  it('removes both tables and the column on the way down', async () => {
    expect(await run('down')).toEqual([
      'ALTER TABLE "applications" DROP COLUMN IF EXISTS "imageRegistryHost"',
      'DROP TABLE IF EXISTS "registry_credentials"',
      'DROP TABLE IF EXISTS "registry_signing_keys"',
    ]);
  });

  it('is registered after the cluster egress policy', () => {
    const at = migrations.indexOf(FluiRegistry1790000000024);
    expect(migrations[at - 1].name).toBe('ClusterEgressPolicy1790000000023');
  });
});
