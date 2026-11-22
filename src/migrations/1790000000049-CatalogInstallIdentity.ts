import { MigrationInterface, QueryRunner } from 'typeorm';

/** The customer identity install a catalog app signs its users in with, when it is not Flui sign-in. */
export class CatalogInstallIdentity1790000000049 implements MigrationInterface {
  name = 'CatalogInstallIdentity1790000000049';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" ADD COLUMN IF NOT EXISTS "identityInstallId" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" DROP COLUMN IF EXISTS "identityInstallId"`,
    );
  }
}
