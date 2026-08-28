import { MigrationInterface, QueryRunner } from 'typeorm';

export class ClusterNodeShape1786700000000 implements MigrationInterface {
  name = 'ClusterNodeShape1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_cluster_nodes" ADD "provider" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_cluster_nodes" ADD "region" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_cluster_nodes" ADD "serverType" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_cluster_nodes" ADD "hourlyPriceEur" numeric(12,6)`,
    );

    // The billable intervals already carry the three fields per node, and they
    // are per-node rather than per-cluster — so they beat the cluster's single
    // nodeSize wherever both exist. Newest interval wins.
    await queryRunner.query(`
      UPDATE "infrastructure_cluster_nodes" n
      SET "provider" = i."provider",
          "region" = i."region",
          "serverType" = i."serverType"
      FROM (
        SELECT DISTINCT ON ("nodeId")
               "nodeId", "provider", "region", "serverType"
        FROM "infrastructure_node_billable_intervals"
        ORDER BY "nodeId", "startedAt" DESC
      ) i
      WHERE i."nodeId" = n."id"
    `);

    await queryRunner.query(`
      UPDATE "infrastructure_cluster_nodes" n
      SET "provider" = COALESCE(n."provider", c."provider"),
          "region" = COALESCE(n."region", NULLIF(c."region", '')),
          "serverType" = COALESCE(n."serverType", NULLIF(c."nodeSize", ''))
      FROM "infrastructure_clusters" c
      WHERE c."id" = n."clusterId"
    `);

    // BYOS writes its own name into region and serverType for want of a value.
    // Carried forward it would read as a location and a size that can be
    // compared and priced; null says what is actually known.
    await queryRunner.query(`
      UPDATE "infrastructure_cluster_nodes"
      SET "region" = NULL
      WHERE "region" IS NOT NULL AND lower("region") = lower("provider")
    `);
    await queryRunner.query(`
      UPDATE "infrastructure_cluster_nodes"
      SET "serverType" = NULL
      WHERE "serverType" IS NOT NULL AND lower("serverType") = lower("provider")
    `);

    await queryRunner.query(`
      UPDATE "infrastructure_cluster_nodes"
      SET "provider" = 'unknown'
      WHERE "provider" IS NULL OR "provider" = ''
    `);
    await queryRunner.query(
      `ALTER TABLE "infrastructure_cluster_nodes" ALTER COLUMN "provider" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_cluster_nodes" DROP COLUMN "hourlyPriceEur"`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_cluster_nodes" DROP COLUMN "serverType"`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_cluster_nodes" DROP COLUMN "region"`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_cluster_nodes" DROP COLUMN "provider"`,
    );
  }
}
