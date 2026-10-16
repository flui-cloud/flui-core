import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every control node becomes a peer of the Flui network of its own.
 *
 * The one control row there was belongs to the master: it is marked primary
 * and given the node id of the newest master that is neither being deleted nor
 * failed. A master that had also been reserved a
 * member address (a control created while the network was on) loses that
 * reservation first, since one node holds one live row. Control workers keep
 * whatever member reservation they had: the hub turns it into a control row on
 * its next pass, keeping the address the node may already carry.
 */
export class ControlPeerPerNode1790000000041 implements MigrationInterface {
  name = 'ControlPeerPerNode1790000000041';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "wg_peers" ADD COLUMN IF NOT EXISTS "isPrimary" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "wg_peers" ADD COLUMN IF NOT EXISTS "controlHandshakes" jsonb`,
    );
    await queryRunner.query(
      `UPDATE "wg_peers" SET "isPrimary" = true WHERE "role" = 'control' AND "revokedAt" IS NULL AND "id" = (SELECT "id" FROM "wg_peers" WHERE "role" = 'control' AND "revokedAt" IS NULL ORDER BY "createdAt" ASC LIMIT 1)`,
    );
    await queryRunner.query(`
      WITH master AS (
        SELECT DISTINCT ON (n."clusterId") n."id", n."clusterId"
          FROM "infrastructure_cluster_nodes" n
          JOIN "wg_peers" c ON c."clusterId" = n."clusterId"
         WHERE c."isPrimary" = true AND c."revokedAt" IS NULL AND c."nodeId" IS NULL
           AND n."nodeType" = 'master' AND n."status" NOT IN ('deleting', 'error')
         ORDER BY n."clusterId", n."createdAt" DESC
      )
      UPDATE "wg_peers" m
         SET "status" = 'revoked', "revokedAt" = now()
        FROM master
       WHERE m."nodeId" = master."id" AND m."role" = 'member' AND m."revokedAt" IS NULL
    `);
    await queryRunner.query(`
      WITH master AS (
        SELECT DISTINCT ON (n."clusterId") n."id", n."clusterId"
          FROM "infrastructure_cluster_nodes" n
         WHERE n."nodeType" = 'master' AND n."status" NOT IN ('deleting', 'error')
         ORDER BY n."clusterId", n."createdAt" DESC
      )
      UPDATE "wg_peers" c
         SET "nodeId" = master."id"
        FROM master
       WHERE c."isPrimary" = true AND c."revokedAt" IS NULL AND c."nodeId" IS NULL
         AND master."clusterId" = c."clusterId"
    `);
    // Global, not per cluster: an installation has exactly one control cluster.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wg_peers_live_primary"
        ON "wg_peers" ("isPrimary")
        WHERE "revokedAt" IS NULL AND "isPrimary" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_wg_peers_live_primary"`);
    await queryRunner.query(
      `UPDATE "wg_peers" SET "status" = 'revoked', "revokedAt" = now() WHERE "role" = 'control' AND "revokedAt" IS NULL AND "isPrimary" = false`,
    );
    await queryRunner.query(
      `UPDATE "wg_peers" SET "nodeId" = NULL WHERE "role" = 'control' AND "isPrimary" = true AND "revokedAt" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "wg_peers" DROP COLUMN IF EXISTS "controlHandshakes"`,
    );
    await queryRunner.query(
      `ALTER TABLE "wg_peers" DROP COLUMN IF EXISTS "isPrimary"`,
    );
  }
}
