import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An application declared on a cluster whose replicas no node has room for
 * yet: waiting on scaling, which is neither a failed install nor a degraded
 * app. Postgres cannot use a value added in the same transaction, hence
 * IF NOT EXISTS and nothing else here.
 */
export class ApplicationWaitingForRoom1789600000000
  implements MigrationInterface
{
  name = 'ApplicationWaitingForRoom1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."applications_status_enum" ADD VALUE IF NOT EXISTS 'waiting_for_room'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."app_revisions_status_enum" ADD VALUE IF NOT EXISTS 'waiting_for_room'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and a row written while it existed
    // would be unreadable if it could.
  }
}
