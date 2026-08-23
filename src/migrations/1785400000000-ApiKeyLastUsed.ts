import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `api_keys.lastUsedAt` — the trace that makes a revocation an informed
 * decision.
 *
 * Until now the row said when a key was created and nothing else, so somebody
 * holding four keys could not tell which one was still serving somebody. What
 * gets revoked in that situation is whichever one looks least familiar, which
 * is not the same question.
 *
 * Additive and nullable, and nullable on purpose: NULL means "not seen since
 * this column existed", which is a different statement from "never used" and
 * the screen has to be able to tell them apart. Backfilling it with
 * `createdAt` would have invented the very fact this column exists to record.
 */
export class ApiKeyLastUsed1785400000000 implements MigrationInterface {
  name = 'ApiKeyLastUsed1785400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "lastUsedAt"`,
    );
  }
}
