import { MigrationInterface, QueryRunner } from 'typeorm';

/** An application's log records what became of an action waiting for its maintenance window. */
export class AppEventMaintenance1789900000001 implements MigrationInterface {
  name = 'AppEventMaintenance1789900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."app_revisions_eventtype_enum" ADD VALUE IF NOT EXISTS 'maintenance'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a value from an enum; rows written with it would have nowhere to go.
  }
}
