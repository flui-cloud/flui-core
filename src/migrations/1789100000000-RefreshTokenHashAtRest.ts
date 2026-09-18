import { createHash } from 'node:crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces every stored refresh token with its SHA-256.
 *
 * `refresh_tokens.token` held the credential verbatim, so a dump of the
 * database handed the reader a live seven-day session for every local account.
 * Exactly the situation {@link ApiKeyHashAtRest1785300000000} was written for,
 * one table later, and it follows that migration down to the shape.
 *
 * **Nothing is invalidated by this.** The stored value IS the plaintext, so the
 * digest is computed from the row itself, in place; `refresh` and `logout` then
 * look up the digest of what the caller presents, and every session that worked
 * before this works after it. Without the migration the runtime change alone
 * would silently log out every local user — and, worse, would leave the
 * plaintext rows sitting in the table until they expired.
 *
 * Expired and revoked rows are rewritten too rather than deleted: deciding that
 * a row is finished belongs to the code that reads it, and a migration that
 * quietly removes rows is a migration nobody can audit afterwards.
 *
 * Done row by row in Node so `pgcrypto` is not a deployment prerequisite, and
 * so the hash comes from the same function the runtime uses.
 */
export class RefreshTokenHashAtRest1789100000000 implements MigrationInterface {
  name = 'RefreshTokenHashAtRest1789100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ id: string; token: string }> = await queryRunner.query(
      `SELECT "id", "token" FROM "refresh_tokens"`,
    );

    for (const row of rows) {
      // Already a digest: safe to meet twice, and an installation seeded after
      // the change has nothing to do.
      if (/^[0-9a-f]{64}$/.test(row.token)) continue;
      const hashed = createHash('sha256')
        .update(row.token.trim(), 'utf8')
        .digest('hex');
      await queryRunner.query(
        `UPDATE "refresh_tokens" SET "token" = $1 WHERE "id" = $2`,
        [hashed, row.id],
      );
    }
  }

  /**
   * The schema is unchanged and the plaintexts are gone, which is the point. A
   * build that expects them back has to let its users log in again; no
   * migration can undo a digest.
   */
  public async down(): Promise<void> {
    return Promise.resolve();
  }
}
