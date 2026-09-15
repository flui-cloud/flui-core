import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The management overlay's peer table.
 *
 * Public material only: a node's private key never leaves the node, and the
 * control cluster's lives in an encrypted column beside the SSH CA. Nothing
 * here is a secret, which is what lets a reconcile loop read it freely.
 *
 * A revoked peer keeps its row. Deleting it would return the address to the
 * pool while stale configs elsewhere may still name it, so a rebuilt node could
 * inherit the identity of the one it replaced.
 */
export class WireGuardPeers1788800000000 implements MigrationInterface {
  name = 'WireGuardPeers1788800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Idempotent throughout: an object that already exists would otherwise
    // abort the whole batch and stop the application starting. Postgres has no
    // CREATE TYPE IF NOT EXISTS, hence the guard.
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."wg_peers_role_enum" AS ENUM('control', 'member');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."wg_peers_status_enum" AS ENUM('pending', 'active', 'stale', 'revoked');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "wg_peers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "nodeId" uuid,
        "clusterId" uuid NOT NULL,
        "role" "public"."wg_peers_role_enum" NOT NULL,
        "publicKey" character varying(64),
        "managementIp" character varying(45) NOT NULL,
        "endpointHost" character varying(255),
        "endpointPort" integer,
        "listenPort" integer,
        "lastHandshakeAt" TIMESTAMP WITH TIME ZONE,
        "status" "public"."wg_peers_status_enum" NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_wg_peers" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wg_peers_nodeId" ON "wg_peers" ("nodeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wg_peers_cluster_status" ON "wg_peers" ("clusterId", "status")`,
    );
    // Two live peers on one address would make WireGuard route to whichever was
    // configured last and blackhole the other. Enforced here as well as in the
    // renderer, because the renderer only sees one config at a time.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wg_peers_live_address"
        ON "wg_peers" ("managementIp")
        WHERE "revokedAt" IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wg_peers_live_node"
        ON "wg_peers" ("nodeId")
        WHERE "revokedAt" IS NULL AND "nodeId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "wg_peers"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."wg_peers_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."wg_peers_role_enum"`,
    );
  }
}
