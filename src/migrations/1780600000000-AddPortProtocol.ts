import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPortProtocol1780600000000 implements MigrationInterface {
  name = 'AddPortProtocol1780600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "portProtocol" character varying(8)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "portProtocol"`,
    );
  }
}
