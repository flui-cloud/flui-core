import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `applications.userId` becomes a reference the database holds.
 *
 * Two rows on the live instance named an owner no `users` row answered for: one
 * a person the sandbox reaper had removed, one `service-account` — the install
 * credential's declared principal, which has no row by design. Neither is
 * reachable by an `owner:` selector, and nothing stopped a third from appearing
 * the next time somebody was deleted. Sweeping them is repair; this is the part
 * that makes the class impossible.
 *
 * Three steps, in this order and not another:
 *
 *  1. **The sweep.** Owners that do not resolve become NULL. This runs here and
 *     not only by hand, because an installation upgrading months from now has
 *     its own dangling rows and no operator watching. It also clears every
 *     non-uuid principal, since such a value can never match a `users.id`.
 *  2. **The type.** The column was `character varying` while `users.id` is
 *     `uuid`; Postgres refuses a foreign key between the two. The cast needs an
 *     explicit `USING` — measured on a throwaway Postgres 15, a bare
 *     `ALTER COLUMN ... TYPE uuid` is refused outright, which is also why
 *     TypeORM's `synchronize` cannot perform this change and a migration has to.
 *  3. **The key**, `ON DELETE SET NULL`: deleting a person empties the column
 *     rather than leaving it pointing at a ghost. NULL is the honest state —
 *     `matchesSelector` already treats a missing owner as matching nobody — and
 *     deleting somebody must never delete their applications.
 *
 * The name is TypeORM's own (`FK_` + sha1('applications_userId')), so that the
 * relation now declared on `ApplicationEntity` matches what is here and a
 * development `synchronize` finds nothing to change. Every step is guarded, so
 * running this against a database already in the target state does nothing.
 */
export class ApplicationOwnerForeignKey1785600000000
  implements MigrationInterface
{
  name = 'ApplicationOwnerForeignKey1785600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "applications" a SET "userId" = NULL
       WHERE a."userId" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "users" u WHERE u."id"::text = a."userId"::text
         )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'applications'
             AND column_name = 'userId'
             AND data_type <> 'uuid'
        ) THEN
          ALTER TABLE "applications"
            ALTER COLUMN "userId" TYPE uuid USING "userId"::uuid;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_90ad8bec24861de0180f638b9cc'
        ) THEN
          ALTER TABLE "applications"
            ADD CONSTRAINT "FK_90ad8bec24861de0180f638b9cc"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  /**
   * Reversible in shape, not in content: the owners the sweep emptied are gone,
   * because they named nobody and there is nothing to put back.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "applications"
        DROP CONSTRAINT IF EXISTS "FK_90ad8bec24861de0180f638b9cc"
    `);
    await queryRunner.query(`
      ALTER TABLE "applications" ALTER COLUMN "userId" TYPE character varying
    `);
  }
}
