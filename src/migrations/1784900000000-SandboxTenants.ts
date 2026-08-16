import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The reserve of pre-built demo tenancies.
 *
 * Two indexes carry invariants rather than speed. The unique one on `namespace`
 * makes it impossible for two rows to claim the same namespace, which is what
 * would let one guest's reaper delete another guest's work. The partial index on
 * `expiresAt` is the reaper's only scan, and it has to stay cheap enough to run
 * every minute forever — a demo that forgets to delete costs money for as long
 * as nobody notices.
 */
export class SandboxTenants1784900000000 implements MigrationInterface {
  name = 'SandboxTenants1784900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "sandbox_tenants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "state" character varying(16) NOT NULL,
        "namespace" character varying(63) NOT NULL,
        "clusterId" uuid NOT NULL,
        "userId" uuid,
        "email" character varying(255) NOT NULL,
        "idpUserId" character varying(64),
        "claimedAt" TIMESTAMP WITH TIME ZONE,
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "claimIpHash" character varying(64),
        "reapedAt" TIMESTAMP WITH TIME ZONE,
        "lastError" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sandbox_tenants" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_sandbox_tenants_namespace" ON "sandbox_tenants" ("namespace")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sandbox_tenants_state" ON "sandbox_tenants" ("state")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sandbox_tenants_expires" ON "sandbox_tenants" ("expiresAt") WHERE "state" = 'claimed'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sandbox_tenants_claim_ip" ON "sandbox_tenants" ("claimIpHash", "claimedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "sandbox_tenants"`);
  }
}
