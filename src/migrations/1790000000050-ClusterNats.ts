import { MigrationInterface, QueryRunner } from 'typeorm';

/** Each cluster's NATS operator, and the accounts it signs for applications. */
export class ClusterNats1790000000050 implements MigrationInterface {
  name = 'ClusterNats1790000000050';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "cluster_nats" ("clusterId" uuid NOT NULL, "operatorSeed" text NOT NULL, "systemAccountSeed" text NOT NULL, "systemAccount" character varying(64) NOT NULL, "operatorJwt" text NOT NULL, "systemAccountJwt" text NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_cluster_nats" PRIMARY KEY ("clusterId"))`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "nats_accounts" ("publicKey" character varying(64) NOT NULL, "clusterId" uuid NOT NULL, "applicationId" uuid NOT NULL, "name" character varying(255) NOT NULL, "seed" text NOT NULL, "jwt" text NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_nats_accounts" PRIMARY KEY ("publicKey"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_nats_accounts_cluster" ON "nats_accounts" ("clusterId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_nats_accounts_app" ON "nats_accounts" ("applicationId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "nats_accounts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "cluster_nats"`);
  }
}
