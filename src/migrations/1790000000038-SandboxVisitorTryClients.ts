import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The client ids of the two "try" applications, kept beside the login-client
 * credential: a token they issued must still be known as a visitor's after the
 * visitors' entrance is shut and the API no longer prepares them.
 */
export class SandboxVisitorTryClients1790000000038
  implements MigrationInterface
{
  name = 'SandboxVisitorTryClients1790000000038';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitor_login_client" ADD COLUMN IF NOT EXISTS "webClientId" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitor_login_client" ADD COLUMN IF NOT EXISTS "cliClientId" character varying(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitor_login_client" DROP COLUMN IF EXISTS "cliClientId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitor_login_client" DROP COLUMN IF EXISTS "webClientId"`,
    );
  }
}
