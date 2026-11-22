import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An application's internal ports beyond the main one, and the public UDP
 * ports it publishes on the node it runs on.
 */
export class AppPorts1790000000051 implements MigrationInterface {
  name = 'AppPorts1790000000051';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "extraPorts" json`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "udpPorts" json`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "udpPorts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "extraPorts"`,
    );
  }
}
