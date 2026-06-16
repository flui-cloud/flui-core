import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestedTlsToCatalogInstall1780800000000
  implements MigrationInterface
{
  name = 'AddRequestedTlsToCatalogInstall1780800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" ADD COLUMN IF NOT EXISTS "requestedTls" boolean NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" DROP COLUMN IF EXISTS "requestedTls"`,
    );
  }
}
