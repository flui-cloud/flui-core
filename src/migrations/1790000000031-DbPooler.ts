import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The connection pooler of a managed PostgreSQL lives on the database's own
 * application row. NULL is "no pooler", the state of every existing install.
 */
export class DbPooler1790000000031 implements MigrationInterface {
  name = 'DbPooler1790000000031';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "pooler" jsonb`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."app_resources_kind_enum" ADD VALUE IF NOT EXISTS 'EndpointSlice'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "pooler"`,
    );
  }
}
