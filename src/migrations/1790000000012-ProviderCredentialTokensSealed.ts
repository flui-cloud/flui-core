import { ConfigService } from '@nestjs/config';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { KeyStorageService } from '../modules/access/services/key-storage.service';

type TokenColumn = 'access_token' | 'refresh_token';
const TOKEN_COLUMNS: readonly TokenColumn[] = ['access_token', 'refresh_token'];

type TokenRow = { id: string } & Record<TokenColumn, string | null>;

/**
 * Seals the provider access and refresh tokens that were stored verbatim,
 * with the key that already seals the password and client secret of
 * the same row. That key lives in the API's environment, never in this table.
 *
 * Tokens were only ever written in plaintext, so a value that does not open
 * with this installation's key is a plaintext token; one that opens is left
 * alone. With no usable key and something to seal the migration throws, which
 * aborts the boot rather than writing a value nothing can read.
 */
export class ProviderCredentialTokensSealed1790000000012
  implements MigrationInterface
{
  name = 'ProviderCredentialTokensSealed1790000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.rewrite(queryRunner, (keyStorage, value) => {
      try {
        keyStorage.openFromString(value);
        return null;
      } catch {
        return keyStorage.encryptKeyToString(value);
      }
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.rewrite(queryRunner, (keyStorage, value) =>
      keyStorage.decryptKeyFromString(value),
    );
  }

  private async rewrite(
    queryRunner: QueryRunner,
    transform: (keyStorage: KeyStorageService, value: string) => string | null,
  ): Promise<void> {
    const rows: TokenRow[] = await queryRunner.query(
      `SELECT "id", "access_token", "refresh_token" FROM "provider_credentials" WHERE "access_token" IS NOT NULL OR "refresh_token" IS NOT NULL`,
    );
    if (rows.length === 0) return;

    const keyStorage = new KeyStorageService(new ConfigService());

    for (const row of rows) {
      const changes: Partial<Record<TokenColumn, string>> = {};
      for (const column of TOKEN_COLUMNS) {
        const value = row[column];
        if (!value) continue;
        const next = transform(keyStorage, value);
        if (next !== null) changes[column] = next;
      }

      const columns = Object.keys(changes) as TokenColumn[];
      if (columns.length === 0) continue;
      await queryRunner.query(
        `UPDATE "provider_credentials" SET ${columns
          .map((column, index) => `"${column}" = $${index + 2}`)
          .join(', ')} WHERE "id" = $1`,
        [row.id, ...columns.map((column) => changes[column])],
      );
    }
  }
}
