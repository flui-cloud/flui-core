import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Captures install/bootstrap log output for a dashboard-driven infrastructure
 * operation (master-node creation, for now) so it can be streamed live and
 * downloaded after the fact without SSH. One row per operation, appended to
 * with `content || :chunk` rather than read-modify-write, which is why this
 * is `text` and not `json`/`jsonb`.
 */
export class InfrastructureOperationLogs1788600000000
  implements MigrationInterface
{
  name = 'InfrastructureOperationLogs1788600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "infrastructure_operation_logs" (
        "id" uuid NOT NULL,
        "operationId" uuid NOT NULL,
        "content" text NOT NULL DEFAULT '',
        "byteOffset" integer NOT NULL DEFAULT 0,
        "sourceFile" character varying,
        "truncated" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_infrastructure_operation_logs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_infrastructure_operation_logs_operationId" UNIQUE ("operationId")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "infrastructure_operation_logs"`);
  }
}
