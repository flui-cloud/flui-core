import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAllowMasterPlacementToCatalogInstall1780600000000
  implements MigrationInterface
{
  name = 'AddAllowMasterPlacementToCatalogInstall1780600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" ADD COLUMN IF NOT EXISTS "allowMasterPlacement" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" DROP COLUMN IF EXISTS "allowMasterPlacement"`,
    );
  }
}
