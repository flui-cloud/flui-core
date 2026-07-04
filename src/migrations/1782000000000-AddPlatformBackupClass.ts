import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * master resilience (MVP-4): the `platform` backup engine class, the `operator`
 * (age-sealed) artifact encryption mode, and the `offProviderAck` attestation on
 * backup destinations. Dev uses synchronize:true so these already exist there;
 * brings prod to parity. Idempotent.
 */
export class AddPlatformBackupClass1782000000000 implements MigrationInterface {
  name = 'AddPlatformBackupClass1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `platform` value on every enum type TypeORM generated for BackupEngineClass columns.
    for (const enumType of [
      'backup_policies_engineclass_enum',
      'backup_artifacts_engineclass_enum',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "${enumType}" ADD VALUE IF NOT EXISTS 'platform'`,
      );
    }

    // `operator` value on every EncryptionMode enum type.
    for (const enumType of [
      'backup_artifacts_encryptionmode_enum',
      'backup_destinations_encryptionmode_enum',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "${enumType}" ADD VALUE IF NOT EXISTS 'operator'`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE "backup_destinations" ADD COLUMN IF NOT EXISTS "offProviderAck" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres cannot drop a single enum value; leaving 'platform'/'operator' in place is safe.
    await queryRunner.query(
      `ALTER TABLE "backup_destinations" DROP COLUMN IF EXISTS "offProviderAck"`,
    );
  }
}
