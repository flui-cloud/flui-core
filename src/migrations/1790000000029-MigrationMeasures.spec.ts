import { QueryRunner } from 'typeorm';
import { MigrationMeasures1790000000029 } from './1790000000029-MigrationMeasures';
import { migrations } from './index';

describe('MigrationMeasures1790000000029', () => {
  it('adds the measures as nullable columns', async () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [];
      }),
    } as unknown as QueryRunner;
    await new MigrationMeasures1790000000029().up(runner);
    const sql = statements.join('\n');

    for (const [table, column] of [
      ['db_migrations', 'writesStoppedAt'],
      ['db_migrations', 'promoteConfirmedAt'],
      ['db_migrations', 'writePauseMs'],
      ['full_migrations', 'writePauseMs'],
      ['full_migrations', 'writePauseEndedBy'],
      ['app_migrations', 'interruptionMs'],
      ['app_migrations', 'dnsFlippedAt'],
    ]) {
      expect(sql).toContain(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}"`,
      );
    }
    expect(sql).not.toContain('NOT NULL');
  });

  it('runs after every earlier migration-feature migration', () => {
    const at = migrations.indexOf(MigrationMeasures1790000000029);
    expect(migrations.slice(at + 1).map((m) => m.name)).toEqual([
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
    ]);
  });
});
