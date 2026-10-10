import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The object storage the instance registry keeps images in, with a credential
 * of its own. Empty until a bucket is connected.
 */
export class RegistryStorage1790000000025 implements MigrationInterface {
  name = 'RegistryStorage1790000000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "registry_storage" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "provider" character varying(32) NOT NULL, "endpoint" character varying(255) NOT NULL, "region" character varying(64) NOT NULL, "bucket" character varying(255) NOT NULL, "prefix" character varying(255) NOT NULL DEFAULT 'zot', "forcePathStyle" boolean NOT NULL DEFAULT false, "accessKeyEncrypted" text NOT NULL, "secretKeyEncrypted" text NOT NULL, "cachePasswordEncrypted" text NOT NULL, "providerResources" jsonb NOT NULL DEFAULT '{}', "active" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_registry_storage" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_registry_storage_one_active" ON "registry_storage" ("active") WHERE "active"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "registry_storage"`);
  }
}
