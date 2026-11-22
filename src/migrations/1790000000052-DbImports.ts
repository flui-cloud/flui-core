import { MigrationInterface, QueryRunner } from 'typeorm';

/** Imports of an external database into a Flui PostgreSQL. */
export class DbImports1790000000052 implements MigrationInterface {
  name = 'DbImports1790000000052';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "db_imports" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "targetApplicationId" uuid NOT NULL, "userId" character varying, "engine" character varying(16) NOT NULL DEFAULT 'postgres', "source" jsonb NOT NULL, "sourcePasswordEncrypted" text, "status" character varying(24) NOT NULL DEFAULT 'checking', "objectName" character varying(63) NOT NULL, "tablesWithoutKey" jsonb NOT NULL DEFAULT '[]', "tablesTotal" integer, "tablesCopied" integer, "lagBytes" bigint, "detail" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "endedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_db_imports" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_db_imports_target" ON "db_imports" ("targetApplicationId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "db_imports"`);
  }
}
