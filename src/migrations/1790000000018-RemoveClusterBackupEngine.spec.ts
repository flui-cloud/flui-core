import { RemoveClusterBackupEngine1790000000018 } from './1790000000018-RemoveClusterBackupEngine';
import { migrations } from './index';
import {
  OperationStep,
  RETIRED_OPERATION_STEPS,
  RETIRED_OPERATION_TYPES,
} from '../modules/infrastructure/servers/entities/infrastructure-operations.entity';
import { RETIRED_ENGINE_CLASSES } from '../modules/backups/enums/backup-engine-class.enum';
import { RETIRED_RESTORE_STRATEGIES } from '../modules/backups/enums/restore-job.enum';

describe('RemoveClusterBackupEngine1790000000018', () => {
  const run = async () => {
    const queries: string[] = [];
    await new RemoveClusterBackupEngine1790000000018().up({
      query: async (sql: string) => {
        queries.push(sql);
      },
    } as never);
    return queries;
  };

  it('is registered after the cluster protections', () => {
    const at = migrations.indexOf(RemoveClusterBackupEngine1790000000018);
    expect(at).toBeGreaterThan(0);
    expect(migrations[at - 1].name).toBe(
      'BackupClusterProtections1790000000017',
    );
  });

  it('adds the uninstall steps the entity declares, without using them', async () => {
    const queries = await run();
    for (const step of [
      OperationStep.VELERO_UNINSTALL_INSPECT,
      OperationStep.VELERO_UNINSTALL_STOP,
      OperationStep.VELERO_UNINSTALL_RELEASE,
      OperationStep.VELERO_UNINSTALL_REMOVE,
      OperationStep.VELERO_UNINSTALL_VERIFY,
      OperationStep.RESTORE_INSTALL_TARGET,
    ]) {
      expect(
        queries.some((q) => q.includes(`ADD VALUE IF NOT EXISTS '${step}'`)),
      ).toBe(true);
    }
    const data = queries.filter((q) => !q.includes('ALTER TYPE'));
    expect(data.join('\n')).not.toContain('velero_uninstall');
  });

  it('pauses every policy of the removed engine with a reason that refuses a resume', async () => {
    const sql = (await run()).find((q) =>
      q.includes('UPDATE "backup_policies"'),
    )!;
    expect(sql).toContain(`"engineClass"::text = 'volume'`);
    expect(sql).toContain(`"enabled" = false`);
    expect(sql).toContain(`"status" = 'paused'`);
    expect(sql).toContain(`'pausedReason', 'engine_removed'`);
  });

  it('keeps the artifacts as retired rows and moves the backup name before dropping its column', async () => {
    const queries = await run();
    const retire = queries.findIndex((q) =>
      q.includes('UPDATE "backup_artifacts"'),
    );
    const drop = queries.findIndex((q) =>
      q.includes(
        'ALTER TABLE "backup_artifacts" DROP COLUMN IF EXISTS "veleroBackupName"',
      ),
    );
    expect(retire).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(retire);
    expect(queries[retire]).toContain(`'backupName', "veleroBackupName"`);
    expect(queries[retire]).toContain(`"expiresAt" = NULL`);
    expect(queries.join('\n')).not.toContain('DELETE FROM');
  });

  it('leaves the engine-class columns without a default instead of the removed one', async () => {
    const queries = await run();
    for (const table of ['backup_policies', 'backup_artifacts']) {
      expect(queries).toContain(
        `ALTER TABLE "${table}" ALTER COLUMN "engineClass" DROP DEFAULT`,
      );
    }
  });

  it('compares the class as text, never as a value of the enum', async () => {
    const data = (await run()).filter((q) => q.includes('"engineClass"'));
    for (const sql of data.filter((q) => q.includes('WHERE'))) {
      expect(sql).toContain(`"engineClass"::text`);
    }
    expect(data.join('\n')).not.toMatch(/SET DEFAULT 'volume_copy'/);
  });

  it('never tries to drop an enum value rows may use', async () => {
    const sql = (await run()).join('\n');
    expect(sql).not.toMatch(/DROP TYPE|RENAME VALUE/);
    expect(RETIRED_ENGINE_CLASSES).toEqual(['volume']);
    expect(RETIRED_RESTORE_STRATEGIES).toEqual(['velero_rebuild']);
    expect(RETIRED_OPERATION_TYPES).toEqual(['install_velero']);
    expect(RETIRED_OPERATION_STEPS).toContain('restore_create_velero_cr');
  });
});
