import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A registry credential was accepted in an application's source but never read
 * by any deploy; it is now refused. What was stored goes — from the
 * application and from every revision snapshot, since a rollback copies the
 * snapshot back. Not reversible: the credential is not kept anywhere to
 * restore it from.
 */
export class DropRegistryAuth1790000000014 implements MigrationInterface {
  name = 'DropRegistryAuth1790000000014';

  static readonly targets = [
    { table: 'applications', column: 'sourceConfig' },
    { table: 'app_revisions', column: 'sourceConfigSnapshot' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { table, column } of DropRegistryAuth1790000000014.targets) {
      await queryRunner.query(
        `UPDATE "${table}" SET "${column}" = ("${column}"::jsonb - 'registryAuth' - 'registryAuthEncrypted' - 'hasRegistryAuth')::json ` +
          `WHERE "${column}"::jsonb ?| array['registryAuth', 'registryAuthEncrypted', 'hasRegistryAuth']`,
      );
    }
  }

  public async down(): Promise<void> {
    // Nothing to put back: the removed credentials are gone by design.
  }
}
