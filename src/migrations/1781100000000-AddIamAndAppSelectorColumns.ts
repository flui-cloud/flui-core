import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * IAM management-plane tables (role bindings + Flui-local groups), first-class
 * projects, and the application selector axes (projectId FK + tags) with indexes
 * for scope filtering. Dev uses synchronize:true so these already exist there;
 * this brings prod to parity. All statements are idempotent.
 */
export class AddIamAndAppSelectorColumns1781100000000
  implements MigrationInterface
{
  name = 'AddIamAndAppSelectorColumns1781100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`,
    );

    // --- IAM role bindings (grants) ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "iam_role_bindings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "principalType" character varying NOT NULL,
        "principalRef" character varying NOT NULL,
        "role" character varying NOT NULL,
        "scopeType" character varying NOT NULL,
        "scopeRef" character varying,
        "selector" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_iam_role_bindings" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_iam_rb_principalType" ON "iam_role_bindings" ("principalType")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_iam_rb_principalRef" ON "iam_role_bindings" ("principalRef")`,
    );

    // --- IAM groups (Flui-local membership) ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "iam_groups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" character varying,
        "members" jsonb NOT NULL DEFAULT '[]',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_iam_groups" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_iam_groups_name" UNIQUE ("name")
      )
    `);

    // --- Projects (first-class, global grouping of apps) ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "projects" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(255) NOT NULL,
        "slug" character varying(255) NOT NULL,
        "description" text,
        "color" character varying(32),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_projects" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_projects_slug" UNIQUE ("slug")
      )
    `);

    // --- Application selector axes ---
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "projectId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "tags" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_applications_projectId'
        ) THEN
          ALTER TABLE "applications"
            ADD CONSTRAINT "FK_applications_projectId"
            FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_applications_kind" ON "applications" ("kind")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_applications_category" ON "applications" ("category")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_applications_clusterId" ON "applications" ("clusterId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_applications_projectId" ON "applications" ("projectId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_applications_tags_gin" ON "applications" USING GIN ("tags")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_applications_tags_gin"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_applications_projectId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_applications_clusterId"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_applications_category"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_applications_kind"`);
    await queryRunner.query(
      `ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "FK_applications_projectId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "tags"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "projectId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "projects"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "iam_groups"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "iam_role_bindings"`);
  }
}
