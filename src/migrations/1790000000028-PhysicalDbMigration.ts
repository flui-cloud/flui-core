import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Live database migration over a temporary direct WireGuard link with
 * physical replication: the links themselves, the replication kind and its
 * two nodes on a replication link, the kind and the write fence on a
 * migration, and the two new steps of the migration operation.
 *
 * Enum values are added with IF NOT EXISTS and not used here: Postgres cannot
 * use a value inside the transaction that adds it.
 */
export class PhysicalDbMigration1790000000028 implements MigrationInterface {
  name = 'PhysicalDbMigration1790000000028';

  static readonly steps = ['db_migrate_link', 'db_migrate_base_backup'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "wg_links" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "purpose" character varying(32) NOT NULL, "ownerId" uuid NOT NULL, "listenerNodeId" uuid NOT NULL, "listenerClusterId" uuid NOT NULL, "dialerNodeId" uuid NOT NULL, "dialerClusterId" uuid NOT NULL, "listenPort" integer NOT NULL, "serviceTcpPort" integer NOT NULL, "dialerEgressIp" character varying(45), "state" character varying(16) NOT NULL DEFAULT 'open', "closeReason" text, "lastHandshakeAt" TIMESTAMP WITH TIME ZONE, "openedAt" TIMESTAMP WITH TIME ZONE, "closedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_wg_links" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wg_links_owner_live" ON "wg_links" ("ownerId") WHERE "state" <> 'closed'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wg_links_listener_open" ON "wg_links" ("listenerNodeId") WHERE "state" = 'open'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wg_links_dialer_open" ON "wg_links" ("dialerNodeId") WHERE "state" = 'open'`,
    );

    await queryRunner.query(
      `ALTER TABLE "db_replication_links" ADD COLUMN IF NOT EXISTS "kind" character varying(16) NOT NULL DEFAULT 'logical'`,
    );
    for (const column of ['wgLinkId', 'srcNodeId', 'dstNodeId']) {
      await queryRunner.query(
        `ALTER TABLE "db_replication_links" ADD COLUMN IF NOT EXISTS "${column}" uuid`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "db_replication_links" ADD COLUMN IF NOT EXISTS "replRole" character varying(64)`,
    );

    await queryRunner.query(
      `ALTER TABLE "db_migrations" ADD COLUMN IF NOT EXISTS "kind" character varying(16) NOT NULL DEFAULT 'logical'`,
    );
    await queryRunner.query(
      `ALTER TABLE "db_migrations" ADD COLUMN IF NOT EXISTS "fence" jsonb`,
    );

    for (const value of PhysicalDbMigration1790000000028.steps) {
      await queryRunner.query(
        `ALTER TYPE "public"."infrastructure_operations_currentstep_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "db_migrations" DROP COLUMN IF EXISTS "fence"`,
    );
    await queryRunner.query(
      `ALTER TABLE "db_migrations" DROP COLUMN IF EXISTS "kind"`,
    );
    for (const column of [
      'replRole',
      'dstNodeId',
      'srcNodeId',
      'wgLinkId',
      'kind',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "db_replication_links" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "wg_links"`);
  }
}
