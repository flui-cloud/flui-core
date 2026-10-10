import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The instance's own image registry: one signing key at a time, and the
 * per-application credentials a build pushes and a cluster pulls with, and
 * on each application the registry its builds were set up to push to.
 * Empty until `FLUI_IMAGE_REGISTRY=flui`.
 */
export class FluiRegistry1790000000024 implements MigrationInterface {
  name = 'FluiRegistry1790000000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "registry_signing_keys" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "kid" character varying(64) NOT NULL, "algorithm" character varying(16) NOT NULL, "publicKeyPem" text NOT NULL, "privateKeyEncrypted" text NOT NULL, "active" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_registry_signing_keys_kid" UNIQUE ("kid"), CONSTRAINT "PK_registry_signing_keys" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_registry_signing_keys_one_active" ON "registry_signing_keys" ("active") WHERE "active"`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "registry_credentials" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "applicationId" uuid NOT NULL, "kind" character varying(8) NOT NULL, "secretHash" character varying(64) NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "revokedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_registry_credentials" PRIMARY KEY ("id"), CONSTRAINT "FK_registry_credentials_application" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_registry_credentials_application" ON "registry_credentials" ("applicationId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "imageRegistryHost" character varying(253)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "imageRegistryHost"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "registry_credentials"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "registry_signing_keys"`);
  }
}
