import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives every platform administrator the binding that will carry their power
 * once the boolean stops carrying it.
 *
 * A role binding names a *role*, never a permission, and until `owner` existed
 * there was no role that meant "everything" — so the seeder wrote `isAdmin:
 * true` and no binding at all. Every live installation is in that state: take
 * the boolean away with nothing written here and its administrators resolve to
 * zero permissions, which is not a degraded product but a locked door.
 *
 * The boolean still works today, so this migration widens nobody: it hands an
 * administrator, through IAM, exactly what they already hold outside it. That is
 * the point — it must land *before* the conversion, not with it, so the two
 * never have to be true at the same instant.
 *
 * Idempotent by predicate rather than by constraint: there is no unique index
 * over (principal, role, scope), so re-running it must find its own work
 * already done rather than trust the database to refuse a duplicate.
 */
export class OwnerRoleBackfill1785100000000 implements MigrationInterface {
  name = 'OwnerRoleBackfill1785100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `principalRef` for a user binding is the email — that is what the policy
    // engine looks bindings up by (`findBindingsFor`), not the row id.
    await queryRunner.query(`
      INSERT INTO "iam_role_bindings"
        ("principalType", "principalRef", "role", "scopeType", "scopeRef", "selector")
      SELECT 'user', u."email", 'owner', 'global', NULL, NULL
      FROM "users" u
      WHERE u."isAdmin" = true
        AND NOT EXISTS (
          SELECT 1 FROM "iam_role_bindings" b
          WHERE b."principalType" = 'user'
            AND b."principalRef" = u."email"
            AND b."role" = 'owner'
            AND b."scopeType" = 'global'
        )
    `);
  }

  /**
   * Removes what `up` inserted — as closely as it can.
   *
   * A global owner binding written by hand to an administrator is
   * indistinguishable from one written here, so the predicate is kept as narrow
   * as the one above (administrators only) instead of deleting every global
   * owner binding there is. Reverting cannot lock anyone out while the boolean
   * is still the operative gate.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "iam_role_bindings" b
      USING "users" u
      WHERE b."principalType" = 'user'
        AND b."principalRef" = u."email"
        AND b."role" = 'owner'
        AND b."scopeType" = 'global'
        AND u."isAdmin" = true
    `);
  }
}
