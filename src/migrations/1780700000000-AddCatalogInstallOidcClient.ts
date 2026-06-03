import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCatalogInstallOidcClient1780700000000
  implements MigrationInterface
{
  name = 'AddCatalogInstallOidcClient1780700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" ADD COLUMN IF NOT EXISTS "oidcAppId" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" ADD COLUMN IF NOT EXISTS "oidcProjectId" character varying(255)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" DROP COLUMN IF EXISTS "oidcProjectId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" DROP COLUMN IF EXISTS "oidcAppId"`,
    );
  }
}
