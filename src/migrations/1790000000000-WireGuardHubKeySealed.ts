import { MigrationInterface, QueryRunner } from 'typeorm';

/** The control's end of the Flui network keeps its key, so a rebuilt control is the same peer. */
export class WireGuardHubKeySealed1790000000000 implements MigrationInterface {
  name = 'WireGuardHubKeySealed1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "wg_peers" ADD COLUMN IF NOT EXISTS "privateKeySealed" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "wg_peers" DROP COLUMN IF EXISTS "privateKeySealed"`,
    );
  }
}
