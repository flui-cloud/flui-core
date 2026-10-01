import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Protect this cluster" becomes one policy per application, including the
 * ones installed later. This row is what remembers the promise for them.
 */
export class BackupClusterProtections1790000000017
  implements MigrationInterface
{
  name = 'BackupClusterProtections1790000000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "backup_cluster_protections" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "clusterId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "destinationId" uuid NOT NULL,
        "replicaDestinationId" uuid,
        "cronSchedule" character varying(64),
        "retentionDays" integer NOT NULL DEFAULT 30,
        "beforeDeploy" boolean NOT NULL DEFAULT false,
        "applications" jsonb NOT NULL DEFAULT '{}',
        "lastReconciledAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_backup_cluster_protections" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_backup_cluster_protections_cluster" ON "backup_cluster_protections" ("clusterId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "backup_cluster_protections"`,
    );
  }
}
