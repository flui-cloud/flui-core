import { MigrationInterface, QueryRunner } from 'typeorm';

/** Registry for object-store share links: revocation + visibility + last-accessed. */
export class CreateObjectStoreShares1781200000000
  implements MigrationInterface
{
  name = 'CreateObjectStoreShares1781200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "object_store_shares" (
        "id" uuid NOT NULL,
        "tokenId" character varying(64) NOT NULL,
        "appId" uuid NOT NULL,
        "bucket" character varying(63) NOT NULL,
        "objectKey" text NOT NULL,
        "ownerUserId" uuid,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "lastAccessedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_object_store_shares" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_object_store_shares_tokenId" ON "object_store_shares" ("tokenId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_object_store_shares_appId" ON "object_store_shares" ("appId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_object_store_shares_appId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_object_store_shares_tokenId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "object_store_shares"`);
  }
}
