import { createHash } from 'node:crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces every stored API key with its SHA-256.
 *
 * `api_keys.key` held `flui_<uuid>` verbatim, so a dump of the database was a
 * dump of the live credentials — nothing to decrypt, nothing else to obtain.
 *
 * **Nothing is invalidated by this.** The stored value IS the plaintext, so the
 * digest can be computed from the row itself, in place, and `findValid` then
 * looks up the digest of whatever the caller presents. Every key that worked
 * before this migration works after it, including keys whose owner no longer
 * exists (27 such rows on the instance this was written against — they are
 * refused by `ApiKeyStrategy`, not by their storage, and that stays true).
 *
 * The column keeps its name. Renaming it to `key_hash` would say the truth, and
 * would also mean every `synchronize: true` development database adds a column
 * and drops the one holding the credentials — a data loss on the way to a
 * clearer name. The entity says `keyHash` and maps it to `key`.
 *
 * Done row by row in Node rather than with `digest()` in SQL so the extension
 * `pgcrypto` is not a deployment prerequisite, and so the hash is produced by
 * exactly the same function the runtime uses.
 */
export class ApiKeyHashAtRest1785300000000 implements MigrationInterface {
  name = 'ApiKeyHashAtRest1785300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ id: string; key: string }> = await queryRunner.query(
      `SELECT "id", "key" FROM "api_keys"`,
    );

    for (const row of rows) {
      // Already a digest: this migration is safe to meet twice, and an
      // installation that was seeded after the change has nothing to do.
      if (/^[0-9a-f]{64}$/.test(row.key)) continue;
      const hashed = createHash('sha256')
        .update(row.key.trim(), 'utf8')
        .digest('hex');
      await queryRunner.query(
        `UPDATE "api_keys" SET "key" = $1 WHERE "id" = $2`,
        [hashed, row.id],
      );
    }
  }

  /**
   * The schema is unchanged, so there is nothing to undo — and the plaintexts
   * are gone, which is the point. A revert leaves the digests where they are;
   * an installation that genuinely wants to go back to a build that expects
   * plaintexts has to re-issue its keys, and no migration can do that for it.
   */
  public async down(): Promise<void> {
    return Promise.resolve();
  }
}
