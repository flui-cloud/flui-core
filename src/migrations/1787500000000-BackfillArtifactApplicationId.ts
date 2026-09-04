import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Puts the application back on the artifacts that only ever named it in jsonb.
 *
 * The unified ledger promised one question — "what protects this application" —
 * answerable with one query. Volume copies populated `applicationId`; the
 * database engine wrote it only into `manifestSummary`, so the class with the
 * strongest protection was the one missing from `backup list --app` and from
 * the per-application status. The rows were never wrong, only unfindable.
 *
 * Copied from `manifestSummary`, which is where the value already is, so this
 * moves a fact rather than inventing one. Guarded on the column being null so
 * a re-run cannot overwrite anything a later backup wrote correctly.
 */
export class BackfillArtifactApplicationId1787500000000
  implements MigrationInterface
{
  name = 'BackfillArtifactApplicationId1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "backup_artifacts"
         SET "applicationId" = ("manifestSummary" ->> 'applicationId')::uuid
       WHERE "applicationId" IS NULL
         AND "manifestSummary" ->> 'applicationId' IS NOT NULL
         AND "manifestSummary" ->> 'applicationId' ~
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    `);
  }

  public async down(): Promise<void> {
    // Deliberately empty: the value is still in `manifestSummary`, so nothing
    // was lost, and clearing the column would re-hide artifacts a later backup
    // legitimately wrote it for.
  }
}
