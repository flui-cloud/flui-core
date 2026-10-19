import { QueryRunner } from 'typeorm';
import { PhysicalDbMigration1790000000028 } from './1790000000028-PhysicalDbMigration';
import { migrations } from './index';

describe('PhysicalDbMigration1790000000028', () => {
  const run = async () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [];
      }),
    } as unknown as QueryRunner;
    await new PhysicalDbMigration1790000000028().up(runner);
    return statements.join('\n');
  };

  it('allows one live link per owner and indexes open links by node', async () => {
    const sql = await run();
    expect(sql).toContain(
      `ON "wg_links" ("ownerId") WHERE "state" <> 'closed'`,
    );
    expect(sql).toContain(
      `ON "wg_links" ("listenerNodeId") WHERE "state" = 'open'`,
    );
    expect(sql).toContain(
      `ON "wg_links" ("dialerNodeId") WHERE "state" = 'open'`,
    );
  });

  it('keeps existing replication links and migrations logical', async () => {
    const sql = await run();
    expect(sql).toContain(
      `"db_replication_links" ADD COLUMN IF NOT EXISTS "kind" character varying(16) NOT NULL DEFAULT 'logical'`,
    );
    expect(sql).toContain(
      `"db_migrations" ADD COLUMN IF NOT EXISTS "kind" character varying(16) NOT NULL DEFAULT 'logical'`,
    );
    expect(sql).toContain(
      `"db_migrations" ADD COLUMN IF NOT EXISTS "fence" jsonb`,
    );
  });

  it('is registered last among the migration-feature migrations', () => {
    const at = migrations.indexOf(PhysicalDbMigration1790000000028);
    expect(at).toBeGreaterThan(0);
    expect(migrations.slice(at + 1).map((m) => m.name)).toEqual([
      'MigrationMeasures1790000000029',
      'BridgeBeforeFence1790000000030',
      'DbPooler1790000000031',
      'DbPoolerCut1790000000032',
      'RegistrySettings1790000000033',
      'SandboxVisitors1790000000034',
      'SandboxVisitorEntrance1790000000035',
      'SandboxVisitorUpgrades1790000000036',
      'SandboxVisitorRecords1790000000037',
      'SandboxVisitorTryClients1790000000038',
      'IdentityEmail1790000000039',
      'IdentityConsoleState1790000000040',
      'ControlPeerPerNode1790000000041',
      'AppHistoryIndexes1790000000042',
      'InferenceUsageIpHash1790000000043',
      'InferenceUsageCachedTokens1790000000044',
    ]);
    expect(migrations[at - 1].name).toMatch(/179000000002[67]$/);
  });
});
