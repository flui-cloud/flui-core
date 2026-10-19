import { MigrationInterface, QueryRunner } from 'typeorm';

export class InferenceUsageIpHash1790000000043 implements MigrationInterface {
  name = 'InferenceUsageIpHash1790000000043';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inference_usage_events" ADD COLUMN IF NOT EXISTS "ipHash" character varying(64)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_inference_usage_ip_created" ON "inference_usage_events" ("ipHash", "createdAt") WHERE "ipHash" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_inference_usage_ip_created"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inference_usage_events" DROP COLUMN IF EXISTS "ipHash"`,
    );
  }
}
