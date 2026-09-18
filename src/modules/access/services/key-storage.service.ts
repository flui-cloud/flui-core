import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * The key every installation used before `SSH_KEY_ENCRYPTION_KEY` was generated
 * at bootstrap. It is published in this repository, so anything still encrypted
 * with it is plaintext to anyone holding a database dump.
 *
 * It stays here as a *decryption* key only: an installation upgrading from an
 * older release has live data sealed with it, and refusing to open that data
 * would lock operators out of their own providers. SecretRotationService walks
 * those records and rewrites them under the real key; this constant can be
 * deleted once no supported upgrade path starts from a release that used it.
 */
export const RETIRED_DEFAULT_KEY_HEX =
  '0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';

const KEY_HEX_LENGTH = 64;

export interface OpenedSecret {
  plaintext: string;
  /** The ciphertext only opened with a retired key, so it needs rewriting. */
  stale: boolean;
}

@Injectable()
export class KeyStorageService {
  private readonly keyBasePath: string;
  private readonly primaryKey: Buffer;
  /** Primary first, then retired keys, tried in order. */
  private readonly openingKeys: readonly Buffer[];
  private readonly logger = new Logger(KeyStorageService.name);

  /** True when this installation still seals new secrets with the public key. */
  readonly sealingWithRetiredKey: boolean;

  constructor(private readonly configService: ConfigService) {
    this.keyBasePath = this.configService.get<string>(
      'SSH_KEYS_PATH',
      '/secure/keys',
    );

    const configured = this.configService
      .get<string>('SSH_KEY_ENCRYPTION_KEY', '')
      .trim();

    if (!configured) {
      this.primaryKey = Buffer.from(RETIRED_DEFAULT_KEY_HEX, 'hex');
      this.sealingWithRetiredKey = true;
      this.logger.error(
        'SSH_KEY_ENCRYPTION_KEY is not set: provider credentials and SSH private keys ' +
          'are being sealed with a key published in the source tree. Set a 64-hex-character ' +
          'key (openssl rand -hex 32) and restart — existing records are re-sealed automatically.',
      );
    } else {
      this.primaryKey = KeyStorageService.parseKey(configured);
      this.sealingWithRetiredKey = configured === RETIRED_DEFAULT_KEY_HEX;
      if (this.sealingWithRetiredKey) {
        this.logger.error(
          'SSH_KEY_ENCRYPTION_KEY is set to the retired default, which is published in ' +
            'the source tree. Generate a fresh one with: openssl rand -hex 32',
        );
      }
    }

    const retired = Buffer.from(RETIRED_DEFAULT_KEY_HEX, 'hex');
    this.openingKeys = this.primaryKey.equals(retired)
      ? [this.primaryKey]
      : [this.primaryKey, retired];
  }

  /**
   * A malformed key must stop the process, not degrade quietly. `Buffer.from`
   * truncates on the first non-hex character, so a typo would otherwise produce
   * a short key that fails later inside `createCipheriv` — at the moment a
   * customer tries to reach their provider, with an error that says nothing.
   */
  private static parseKey(hex: string): Buffer {
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== KEY_HEX_LENGTH) {
      throw new Error(
        `SSH_KEY_ENCRYPTION_KEY must be ${KEY_HEX_LENGTH} hexadecimal characters ` +
          `(32 bytes); got ${hex.length}. Generate one with: openssl rand -hex 32`,
      );
    }
    return Buffer.from(hex, 'hex');
  }

  /** Stable, non-reversible label for the active key, safe to log or expose. */
  get keyFingerprint(): string {
    return crypto
      .createHash('sha256')
      .update(this.primaryKey)
      .digest('hex')
      .slice(0, 16);
  }

  async storePrivateKey(
    userId: string,
    keyId: string,
    privateKey: string,
  ): Promise<string> {
    const keyPath = this.getKeyPath(userId, keyId);
    await fs.mkdir(path.dirname(keyPath), { recursive: true });

    const encryptedKey = this.encryptKey(privateKey);
    await fs.writeFile(keyPath, encryptedKey);
    await fs.chmod(keyPath, 0o600);

    return keyPath;
  }

  async retrievePrivateKey(keyPath: string): Promise<string> {
    const encryptedKey = await fs.readFile(this.assertStoredPath(keyPath));
    return this.decryptKey(encryptedKey);
  }

  async deleteKey(keyPath: string): Promise<void> {
    const safePath = this.assertStoredPath(keyPath);
    try {
      await fs.unlink(safePath);
      await this.cleanupKeyDirectory(safePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  public encryptKeyToString(privateKey: string): string {
    const encryptedBuffer = this.encryptKey(privateKey);
    return encryptedBuffer.toString('base64');
  }

  public encryptKey(privateKey: string): Buffer {
    // Sealing with the retired key is refused; opening with it is not.
    //
    // The previous behaviour was to log an error and seal anyway, which is the
    // worst of both: the operator sees a line in a log they may never read, and
    // every provider credential and SSH private key written from then on is
    // encrypted with a key that is published in this repository — recoverable by
    // anyone who obtains the database. Refusing here rather than at startup is
    // deliberate: records already sealed with it stay readable, so an
    // installation that lands in this state can be repaired by setting a real
    // key and restarting, which is what re-seals them. Refusing to boot would
    // take that path away.
    if (this.sealingWithRetiredKey) {
      throw new Error(
        'Refusing to encrypt: SSH_KEY_ENCRYPTION_KEY is unset or is the retired default, ' +
          'which is published in the source tree. Set a 64-hex-character key ' +
          '(openssl rand -hex 32) and restart — existing records are re-sealed automatically.',
      );
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.primaryKey, iv);

    const encrypted = Buffer.concat([
      cipher.update(privateKey, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, encrypted]);
  }

  public decryptKey(encryptedData: Buffer): string {
    return this.open(encryptedData).plaintext;
  }

  public decryptKeyFromString(encryptedString: string): string {
    return this.openFromString(encryptedString).plaintext;
  }

  /**
   * Decrypts and reports which generation of key opened the record.
   *
   * GCM authenticates before it returns anything, so trying keys in turn is
   * unambiguous: a wrong key fails the tag check rather than yielding garbage.
   */
  public open(encryptedData: Buffer): OpenedSecret {
    const iv = encryptedData.subarray(0, 16);
    const authTag = encryptedData.subarray(16, 32);
    const payload = encryptedData.subarray(32);

    for (const [index, key] of this.openingKeys.entries()) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([
          decipher.update(payload),
          decipher.final(),
        ]).toString('utf8');
        return { plaintext, stale: index > 0 };
      } catch {
        continue;
      }
    }

    throw new Error(
      "Could not decrypt: the record was not sealed with this installation's key. " +
        'If SSH_KEY_ENCRYPTION_KEY was changed by hand, restore the previous value — ' +
        'the data cannot be recovered without it.',
    );
  }

  public openFromString(encryptedString: string): OpenedSecret {
    return this.open(Buffer.from(encryptedString, 'base64'));
  }

  /**
   * The only place a key file's location is decided, and therefore the only
   * place worth asserting it.
   *
   * `userId` is whatever the caller passed as a user name, and `path.join`
   * resolves `..` silently — a name of `../../../etc` wrote sealed key material
   * outside the keys root. Validating the field on the way in is worth doing and
   * is done, but the containment check belongs here: it holds for every caller,
   * including ones that do not exist yet.
   */
  private getKeyPath(userId: string, keyId: string): string {
    const root = path.resolve(this.keyBasePath);
    const resolved = path.resolve(root, userId, keyId, 'private.key');
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new BadRequestException(
        'Invalid SSH key location: the name resolves outside the keys directory',
      );
    }
    return resolved;
  }

  /**
   * Removes the directories a deleted key leaves empty, and stops at the keys
   * root.
   *
   * Without the stop it kept going: root, then the root's parent, then upward
   * until it met something non-empty. On an installation whose keys root is a
   * mount of its own that is the mount point; and it is the second place, after
   * `getKeyPath`, where a path that escaped containment turns into a filesystem
   * operation.
   */
  private async cleanupKeyDirectory(keyPath: string): Promise<void> {
    const root = path.resolve(this.keyBasePath);
    const directory = path.dirname(path.resolve(keyPath));
    if (directory === root || !directory.startsWith(root + path.sep)) return;

    const files = await fs.readdir(directory);
    if (files.length === 0) {
      await fs.rmdir(directory);
      await this.cleanupKeyDirectory(directory);
    }
  }

  /**
   * A path read back from the database, asserted before it is acted on.
   *
   * `keyPath` is written only by `storePrivateKey`, which is contained — but
   * rows written before that containment existed are still in the table, and a
   * row is a weaker guarantee than a check. Reading one of those is harmless
   * (the seal fails), deleting one is not.
   */
  private assertStoredPath(keyPath: string): string {
    const root = path.resolve(this.keyBasePath);
    const resolved = path.resolve(keyPath);
    if (!resolved.startsWith(root + path.sep)) {
      throw new BadRequestException(
        'Invalid SSH key location: the stored path is outside the keys directory',
      );
    }
    return resolved;
  }
}
