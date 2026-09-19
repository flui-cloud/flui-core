import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The ledger of what inference has cost.
 *
 * One row per call, written by the single point every surface reaches the
 * provider through. A guest's budget is a `SUM` over it, so the number a person
 * is shown and the number an operator reads are the same number.
 *
 * Nothing is backfilled: calls made before this existed left no trace to
 * recover, and inventing rows for them would put made-up money in the first
 * report somebody reads.
 */
export class InferenceUsageEvents1789200000000 implements MigrationInterface {
  name = 'InferenceUsageEvents1789200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inference_usage_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid,
        "guest" boolean NOT NULL DEFAULT false,
        "model" character varying(128) NOT NULL,
        "endpoint" character varying(255) NOT NULL,
        "surface" character varying(64) NOT NULL,
        "promptTokens" integer NOT NULL DEFAULT 0,
        "completionTokens" integer NOT NULL DEFAULT 0,
        "estimated" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_inference_usage_events" PRIMARY KEY ("id")
      )
    `);
    // The two reads this table exists for: one person's total, and everything
    // in a window. Neither can afford a sequential scan once a launch has been
    // through it.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_inference_usage_user_created"
        ON "inference_usage_events" ("userId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_inference_usage_created"
        ON "inference_usage_events" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "inference_usage_events"`);
  }
}
