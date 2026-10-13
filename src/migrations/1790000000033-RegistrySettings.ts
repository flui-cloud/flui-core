import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The registry an installation switched to after install, and where it keeps
 * images. Empty until someone switches: the install-time environment decides.
 */
export class RegistrySettings1790000000033 implements MigrationInterface {
  name = 'RegistrySettings1790000000033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "registry_settings" ("id" character varying(16) NOT NULL, "mode" character varying(8) NOT NULL, "storageBackend" character varying(16) NOT NULL, "changedByUserId" character varying(64), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_registry_settings" PRIMARY KEY ("id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "registry_settings"`);
  }
}
