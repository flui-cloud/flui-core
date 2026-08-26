import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The operating context: one new table, and nothing touched.
 *
 * Knowledge — rules and reasons a person wrote — beside the state the platform
 * owns and the history it already records. It stores neither of those: no
 * column here holds a fact the product can answer, because a copy of a fact is
 * exactly the thing that goes quietly wrong. What it stores instead is the
 * *premise* an entry leans on (`probeId` + `probeParams` + `probeOp` +
 * `probeExpected`), so the entry can be re-compared with live state and
 * withdraw itself when the comparison fails.
 *
 * Procedure, after the round that lost thirty-two rows: a new table rather than
 * a column on an existing one, every optional column nullable, no foreign key —
 * a note about a cluster outlives the cluster, and that is when it is most
 * worth reading — no type changed anywhere, `CREATE TABLE IF NOT EXISTS`, and
 * the entity written in the same pass, because
 * `RdbmsSchemaBuilder.dropRemovedColumns` deletes any column the database has
 * and the entity does not.
 */
export class OperatingContext1786000000000 implements MigrationInterface {
  name = 'OperatingContext1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "operating_context_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "scopeType" character varying NOT NULL,
        "scopeRef" character varying,
        "selector" jsonb,
        "nature" character varying NOT NULL DEFAULT 'practice',
        "topic" character varying NOT NULL,
        "title" character varying NOT NULL,
        "body" text NOT NULL,
        "checkKind" character varying NOT NULL DEFAULT 'none',
        "probeId" character varying,
        "probeParams" jsonb,
        "probeOp" character varying,
        "probeExpected" jsonb,
        "confirmedAt" TIMESTAMP WITH TIME ZONE,
        "confirmedByUserId" character varying,
        "validForDays" integer,
        "lastProbeStatus" character varying,
        "lastProbeAt" TIMESTAMP WITH TIME ZONE,
        "lastProbeDetail" text,
        "authorUserId" character varying NOT NULL,
        "archivedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_operating_context_entries" PRIMARY KEY ("id")
      )
    `);
    // Every read starts by taking the live entries and splitting them by level;
    // the reachability filter then runs in memory against one resolved access.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_operating_context_scope" ON "operating_context_entries" ("scopeType", "archivedAt")`,
    );
    // Conflicts are found by topic, and only among entries that reach the same
    // reader — so the grouping has to be cheap enough to do on every delivery.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_operating_context_topic" ON "operating_context_entries" ("topic")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_operating_context_topic"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_operating_context_scope"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "operating_context_entries"`);
  }
}
