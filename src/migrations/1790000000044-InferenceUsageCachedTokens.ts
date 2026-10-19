import { MigrationInterface, QueryRunner } from 'typeorm';

export class InferenceUsageCachedTokens1790000000044
  implements MigrationInterface
{
  name = 'InferenceUsageCachedTokens1790000000044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inference_usage_events" ADD COLUMN IF NOT EXISTS "cachedPromptTokens" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inference_usage_events" DROP COLUMN IF EXISTS "cachedPromptTokens"`,
    );
  }
}
