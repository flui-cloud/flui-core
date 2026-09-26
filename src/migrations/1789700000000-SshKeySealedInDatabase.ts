import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The sealed private half of an SSH key, kept with its record. The key file
 * lived on the API's own filesystem, which does not outlive a restart; the
 * sealing key stays in the API's environment, never in this table.
 */
export class SshKeySealedInDatabase1789700000000 implements MigrationInterface {
  name = 'SshKeySealedInDatabase1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ssh_keys" ADD COLUMN IF NOT EXISTS "sealedPrivateKey" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ssh_keys" DROP COLUMN IF EXISTS "sealedPrivateKey"`,
    );
  }
}
