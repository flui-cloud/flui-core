import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deleting a cluster closed its machines' billed lifetimes only on the forced
 * path, so a deleted cluster kept accruing and forecasting cost, and a node
 * could hold several open lifetimes at once and be counted as many times.
 *
 * Repairs the record in three steps, each a no-op on a second run:
 *
 *  - Several open lifetimes of one node become consecutive ones: each ends
 *    where the next begins, and only the latest stays open. The node is then
 *    counted once, from its first start, and a resize whose close failed keeps
 *    its later shape.
 *  - Every lifetime still open on a deleted cluster ends when the cluster was
 *    deleted: `deletedAt`, written together with the `deleted` status, and
 *    `updatedAt` where a row lacks it, which is never earlier than the
 *    deletion. Never before the lifetime's own start.
 *  - One open lifetime per node is enforced from now on.
 */
export class CloseDeletedClusterIntervals1790000000013
  implements MigrationInterface
{
  name = 'CloseDeletedClusterIntervals1790000000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "infrastructure_node_billable_intervals" i
      SET "endedAt" = n."nextStartedAt"
      FROM (
        SELECT "id",
               LEAD("startedAt") OVER (
                 PARTITION BY "nodeId" ORDER BY "startedAt", "id"
               ) AS "nextStartedAt"
        FROM "infrastructure_node_billable_intervals"
        WHERE "endedAt" IS NULL
      ) n
      WHERE n."id" = i."id"
        AND n."nextStartedAt" IS NOT NULL
        AND i."endedAt" IS NULL
    `);

    for (const table of [
      'infrastructure_node_billable_intervals',
      'infrastructure_volume_billable_intervals',
    ]) {
      await queryRunner.query(`
        UPDATE "${table}" i
        SET "endedAt" = GREATEST(i."startedAt", COALESCE(c."deletedAt", c."updatedAt"))
        FROM "infrastructure_clusters" c
        WHERE c."id" = i."clusterId"
          AND i."endedAt" IS NULL
          AND (c."status" = 'deleted' OR c."deletedAt" IS NOT NULL)
      `);
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_node_billable_intervals_open_node"
        ON "infrastructure_node_billable_intervals" ("nodeId")
        WHERE "endedAt" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_node_billable_intervals_open_node"`,
    );
  }
}
