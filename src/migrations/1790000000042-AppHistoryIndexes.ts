import { MigrationInterface, QueryRunner } from 'typeorm';

export class AppHistoryIndexes1790000000042 implements MigrationInterface {
  name = 'AppHistoryIndexes1790000000042';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_app_revisions_application_created" ON "app_revisions" ("applicationId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_app_resources_application" ON "app_resources" ("applicationId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_app_resources_application"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_app_revisions_application_created"`,
    );
  }
}
