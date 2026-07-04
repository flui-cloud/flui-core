import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * db-lifecycle: logical-replication link state (Stage 2 primitives / future
 * live-migration state machine). Dev uses synchronize:true so this already
 * exists there; brings prod to parity. Idempotent.
 */
export class CreateDbReplicationLinks1781500000000
  implements MigrationInterface
{
  name = 'CreateDbReplicationLinks1781500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'db_replication_links_status_enum') THEN
          CREATE TYPE "db_replication_links_status_enum" AS ENUM
            ('init', 'copying', 'streaming', 'promoted', 'failed', 'aborted');
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "db_replication_links" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "srcAppId" uuid NOT NULL,
        "dstAppId" uuid NOT NULL,
        "pubName" character varying(64) NOT NULL,
        "subName" character varying(64) NOT NULL,
        "slotName" character varying(64) NOT NULL,
        "replRolePasswordEncrypted" text NOT NULL,
        "transport" jsonb,
        "status" "db_replication_links_status_enum" NOT NULL DEFAULT 'init',
        "lagBytes" bigint,
        "errorMessage" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_db_replication_links" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_db_repl_links_src" ON "db_replication_links" ("srcAppId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_db_repl_links_dst" ON "db_replication_links" ("dstAppId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "db_replication_links"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "db_replication_links_status_enum"`,
    );
  }
}
