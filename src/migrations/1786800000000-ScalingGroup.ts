import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The scaling group as a resource, and the decisions it takes.
 *
 * Two tables rather than columns on `infrastructure_clusters`, because a
 * cluster commonly wants more than one group — one for the general work, one
 * for the heavy jobs — and they differ in every field here.
 *
 * Written by hand and appended, following the procedure the last rounds
 * established: additive only, nothing altered on an existing table, and the
 * entities edited in the same pass.
 *
 * Two column choices carry meaning that a default would destroy:
 * `maxMonthlyCost` is nullable with **no** default, because a missing ceiling
 * and a ceiling of zero are opposite instructions; `hourlyPriceEur` on a
 * decision is nullable for the same reason — Flui never sees a bill for the
 * operator's own machines, and a zero there would claim they are free.
 *
 * `clusterId` carries no foreign key, matching the sibling table that already
 * records fleet history the same way.
 *
 * `pendingPods` and `drain` are nullable for the same reason as the price: a
 * cluster that could not be asked is not a cluster with nothing waiting, and a
 * node nobody examined is not a node that can be emptied. Both are readings the
 * pass already made, kept so a list of clusters does not have to make them
 * again, once per row, across the network.
 */
export class ScalingGroup1786800000000 implements MigrationInterface {
  name = 'ScalingGroup1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "infrastructure_scaling_groups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "clusterId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "minNodes" integer NOT NULL DEFAULT 1,
        "desiredNodes" integer NOT NULL DEFAULT 1,
        "maxNodes" integer NOT NULL DEFAULT 1,
        "regions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "shapes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "strategy" character varying NOT NULL DEFAULT 'uniform',
        "settleSeconds" integer NOT NULL DEFAULT 30,
        "hourlyBillingOnly" boolean NOT NULL DEFAULT false,
        "maxMonthlyCost" numeric(12,2),
        "provision" character varying NOT NULL DEFAULT 'manual',
        "standingOrders" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "requirement" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_infrastructure_scaling_groups" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_scaling_groups_cluster" ON "infrastructure_scaling_groups" ("clusterId")`,
    );
    // One name per cluster: the name is how a person and a file refer to a
    // group, so two of them under one cluster is an ambiguity, not a variant.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_scaling_groups_cluster_name" ON "infrastructure_scaling_groups" ("clusterId", "name")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "infrastructure_scaling_decisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "groupId" uuid NOT NULL,
        "clusterId" uuid NOT NULL,
        "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "force" character varying NOT NULL,
        "outcome" character varying NOT NULL,
        "saw" text NOT NULL,
        "did" text NOT NULL,
        "why" text NOT NULL,
        "asks" text,
        "shape" character varying,
        "region" character varying,
        "hourlyPriceEur" numeric(12,6),
        "considered" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "pendingPods" integer,
        "drain" jsonb,
        CONSTRAINT "PK_infrastructure_scaling_decisions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_scaling_decisions_group_at" ON "infrastructure_scaling_decisions" ("groupId", "at")`,
    );
    // The overview asks a cluster for its last decision and its open alarm
    // without walking its groups first, so the cluster gets its own index.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_scaling_decisions_cluster_at" ON "infrastructure_scaling_decisions" ("clusterId", "at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_scaling_decisions_cluster_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_scaling_decisions_group_at"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "infrastructure_scaling_decisions"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_scaling_groups_cluster_name"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_scaling_groups_cluster"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "infrastructure_scaling_groups"`,
    );
  }
}
