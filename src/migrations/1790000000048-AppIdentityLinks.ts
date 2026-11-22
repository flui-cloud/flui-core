import { MigrationInterface, QueryRunner } from 'typeorm';

/** Which application signs in against which customer identity install, and the client made for it. */
export class AppIdentityLinks1790000000048 implements MigrationInterface {
  name = 'AppIdentityLinks1790000000048';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "app_identity_links" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "applicationId" uuid NOT NULL, "identityInstallId" uuid NOT NULL, "projectId" character varying(64) NOT NULL, "clientAppId" character varying(64) NOT NULL, "clientId" character varying(128) NOT NULL, "issuer" character varying(512) NOT NULL, "redirectUris" jsonb NOT NULL DEFAULT '[]', "envNames" jsonb NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_app_identity_links" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_identity_links_app" ON "app_identity_links" ("applicationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_app_identity_links_install" ON "app_identity_links" ("identityInstallId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "app_identity_links"`);
  }
}
