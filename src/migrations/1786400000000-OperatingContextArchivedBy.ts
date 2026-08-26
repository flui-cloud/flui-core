import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records who withdrew an operating-context note.
 *
 * The archive could already be read back, but not attributed: a retired rule
 * said who had written it and nothing about who decided it had stopped being
 * true — which is the person to ask before writing it again, and the whole
 * reason somebody opens the archive.
 *
 * Nullable and without a foreign key, like `authorUserId` and
 * `confirmedByUserId` beside it: every note retired before this column
 * existed keeps a null, and a person leaving the installation must not take
 * the record of what they decided with them. Nothing is backfilled — there is
 * nowhere to read the answer from, and inventing one would put a name against
 * a decision that person may not have made.
 */
export class OperatingContextArchivedBy1786400000000
  implements MigrationInterface
{
  name = 'OperatingContextArchivedBy1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "operating_context_entries" ADD COLUMN IF NOT EXISTS "archivedByUserId" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "operating_context_entries" DROP COLUMN IF EXISTS "archivedByUserId"`,
    );
  }
}
