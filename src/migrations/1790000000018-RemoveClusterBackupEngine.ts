import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Velero is gone from Flui: nothing installs it, runs it or restores from it.
 *
 * Its policies are paused, not converted. A Velero policy selected namespaces
 * or the whole cluster, so no row names the one application a volume copy
 * needs; the policies that replace them come from protecting the cluster,
 * which gives every application its own. `pausedReason = 'engine_removed'`
 * is what refuses a resume.
 *
 * Its artifacts stay as rows, marked retired, with the backup name moved into
 * `metadata.retired`. Their data is still in the destinations and nothing will
 * expire it without Velero, so `expiresAt` is cleared: the retention sweep
 * would otherwise forget the rows and leave the objects with nothing pointing
 * at them. Deleting that data is a person's decision.
 *
 * The engine-class columns lose their default: every writer names the class,
 * and a row that does not should fail rather than become a copy it is not.
 * (`volume_copy` could not be the default here anyway: on a fresh database it
 * is added earlier in this same transaction, and Postgres refuses a new enum
 * value used before that transaction commits. Every comparison below is on
 * the text for the same reason.)
 *
 * The three name columns and their index go. The enum values stay: Postgres
 * cannot drop a value that rows use (`volume` on both engine-class types,
 * `velero_rebuild`, `install_velero` and the install steps), so the entities
 * keep them in the column types and the API no longer accepts them.
 *
 * The uninstall operation's steps and the database restore's own install step
 * are added the usual way: IF NOT EXISTS, and not used here, because a value
 * added inside the migration transaction cannot be used in it.
 */
export class RemoveClusterBackupEngine1790000000018
  implements MigrationInterface
{
  name = 'RemoveClusterBackupEngine1790000000018';

  static readonly steps = [
    'velero_uninstall_inspect',
    'velero_uninstall_stop',
    'velero_uninstall_release',
    'velero_uninstall_remove',
    'velero_uninstall_verify',
    'restore_install_target',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of RemoveClusterBackupEngine1790000000018.steps) {
      await queryRunner.query(
        `ALTER TYPE "public"."infrastructure_operations_currentstep_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }

    await queryRunner.query(`
      UPDATE "backup_policies"
      SET "enabled" = false,
          "status" = 'paused',
          "nextRunAt" = NULL,
          "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
            'pausedReason', 'engine_removed',
            'pausedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          )
      WHERE "engineClass"::text = 'volume'
    `);

    await queryRunner.query(`
      UPDATE "backup_artifacts"
      SET "expiresAt" = NULL,
          "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
            'retired', jsonb_strip_nulls(jsonb_build_object(
              'reason', 'engine_removed',
              'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'backupName', "veleroBackupName"
            ))
          )
      WHERE "engineClass"::text = 'volume'
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_backup_artifacts_velero_name"`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" DROP COLUMN IF EXISTS "veleroBackupName"`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_jobs" DROP COLUMN IF EXISTS "veleroBackupName"`,
    );
    await queryRunner.query(
      `ALTER TABLE "restore_jobs" DROP COLUMN IF EXISTS "veleroRestoreName"`,
    );

    await queryRunner.query(
      `ALTER TABLE "backup_policies" ALTER COLUMN "engineClass" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" ALTER COLUMN "engineClass" DROP DEFAULT`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backup_policies" ALTER COLUMN "engineClass" SET DEFAULT 'volume'`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" ALTER COLUMN "engineClass" SET DEFAULT 'volume'`,
    );
    await queryRunner.query(
      `ALTER TABLE "restore_jobs" ADD COLUMN IF NOT EXISTS "veleroRestoreName" character varying(253)`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_jobs" ADD COLUMN IF NOT EXISTS "veleroBackupName" character varying(253)`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" ADD COLUMN IF NOT EXISTS "veleroBackupName" character varying(253)`,
    );
    await queryRunner.query(
      `UPDATE "backup_artifacts" SET "veleroBackupName" = "metadata"->'retired'->>'backupName' WHERE "metadata"->'retired' ? 'backupName'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_backup_artifacts_velero_name" ON "backup_artifacts" ("veleroBackupName")`,
    );
    // The policies stay paused and the artifacts keep no expiry: nothing that
    // could run them comes back with this.
  }
}
