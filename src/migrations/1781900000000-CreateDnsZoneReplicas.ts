import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * dual-provider DNS redundancy (MVP-2): the dns_zone_replicas table + the
 * recordTtlSeconds column on dns_zones. Dev uses synchronize:true so these
 * already exist there; brings prod to parity. Idempotent.
 */
export class CreateDnsZoneReplicas1781900000000 implements MigrationInterface {
  name = 'CreateDnsZoneReplicas1781900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dns_zone_replicas_status_enum') THEN
          CREATE TYPE "dns_zone_replicas_status_enum" AS ENUM
            ('pending', 'populating', 'active', 'degraded', 'disabled');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dns_zone_replicas_dnsprovider_enum') THEN
          CREATE TYPE "dns_zone_replicas_dnsprovider_enum" AS ENUM ('hetzner', 'scaleway', 'none');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dns_zone_replicas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "dnsZoneId" uuid NOT NULL,
        "dnsProvider" "dns_zone_replicas_dnsprovider_enum" NOT NULL,
        "providerZoneId" varchar NOT NULL,
        "status" "dns_zone_replicas_status_enum" NOT NULL DEFAULT 'pending',
        "lastReconciledAt" TIMESTAMP WITH TIME ZONE,
        "errorMessage" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dns_zone_replicas" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dns_zone_replicas_zone_provider" UNIQUE ("dnsZoneId", "dnsProvider"),
        CONSTRAINT "FK_dns_zone_replicas_zone" FOREIGN KEY ("dnsZoneId")
          REFERENCES "dns_zones"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "dns_zones" ADD COLUMN IF NOT EXISTS "recordTtlSeconds" integer NOT NULL DEFAULT 300`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dns_zone_replicas"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "dns_zone_replicas_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "dns_zone_replicas_dnsprovider_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dns_zones" DROP COLUMN IF EXISTS "recordTtlSeconds"`,
    );
  }
}
