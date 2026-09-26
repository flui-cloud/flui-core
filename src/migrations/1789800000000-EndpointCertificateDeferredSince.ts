import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When an endpoint's certificate was first held back because its name was not
 * yet published, so the wait can be retried on its own and turned into an
 * error once it has lasted too long.
 */
export class EndpointCertificateDeferredSince1789800000000
  implements MigrationInterface
{
  name = 'EndpointCertificateDeferredSince1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_endpoints" ADD COLUMN IF NOT EXISTS "certificateDeferredSince" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_endpoints" DROP COLUMN IF EXISTS "certificateDeferredSince"`,
    );
  }
}
