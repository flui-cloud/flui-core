import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What a destination hears: `infrastructure` (alerts no application owns) or
 * `all`. Existing rows narrow to `infrastructure`, since whoever added them was
 * never asked whether they may read every tenant's alerts.
 */
export class AlertDestinationScope1790000000011 implements MigrationInterface {
  name = 'AlertDestinationScope1790000000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "alert_destinations" ADD COLUMN IF NOT EXISTS "scope" character varying(16) NOT NULL DEFAULT 'infrastructure'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "alert_destinations" DROP COLUMN IF EXISTS "scope"`,
    );
  }
}
