import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `applications.userId = NULL` was answering two questions with one silence.
 *
 * The bootstrap has declared the difference on its manifests since it wrote
 * them: `flui.cloud/owner-kind: platform` / `flui.cloud/owner-id: flui-core` on
 * everything it installs. Nothing here read it, so discovery translated a
 * declaration into an absence, and the absence had to stand for both *the
 * platform put this here* and *an install credential recorded no owner*.
 *
 * Two columns, so the row can say which:
 *
 *  - `ownerKind` — `platform` or `user`, exactly as declared;
 *  - `ownerRef` — which side declares it (`flui-core`).
 *
 * Additive, nullable, **no foreign key** and no type change: outside production
 * this schema is reached by `synchronize: true` against a real cluster's
 * Postgres, and a column TypeORM cannot recognise is a column it drops. Not a
 * foreign key either — `ownerRef` names a side of the system, not a row, and
 * nothing on this instance could be its referent.
 *
 * **No data backfill, deliberately.** The rows already written carry nothing,
 * and the honest source of the value is the label on the live resource, not a
 * guess made here from a slug. Discovery re-runs against every cluster and
 * converges each row from what the cluster actually declares — the same shape
 * as the exposure convergence that precedes it. A backfill written in SQL would
 * have to encode "the system apps are the ones called postgres, redis,
 * zitadel…", which is the name-guessing this change exists to replace, and it
 * would write `platform` onto Umami's databases — the exact rows whose missing
 * owner is a defect that must stay visible. Until discovery has run, an
 * undeclared row reads as unattributed, which is the safe answer and the true
 * one.
 */
export class ApplicationOwnerKind1786600000000 implements MigrationInterface {
  name = 'ApplicationOwnerKind1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "ownerKind" character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "ownerRef" character varying(253)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "ownerRef"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "ownerKind"`,
    );
  }
}
