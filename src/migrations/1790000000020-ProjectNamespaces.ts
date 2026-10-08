import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A project now describes the namespace its applications run in. A person's
 * personal project is the one owned by them; every other project has no owner.
 * A catalog install remembers the project it was asked for. Both columns are
 * null on every existing row.
 */
export class ProjectNamespaces1790000000020 implements MigrationInterface {
  name = 'ProjectNamespaces1790000000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "ownerUserId" uuid`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_projects_personal_owner" ON "projects" ("ownerUserId") WHERE "ownerUserId" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" ADD COLUMN IF NOT EXISTS "projectId" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "catalog_installs" DROP COLUMN IF EXISTS "projectId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_projects_personal_owner"`,
    );
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN IF EXISTS "ownerUserId"`,
    );
  }
}
