import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ENCRYPTION_KEY_UNAVAILABLE_VAR,
  EncryptionKeyUnavailableError,
  openWithPlatformKey,
  sealWithPlatformKey,
} from '../platform-cipher';

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly resolvedKey: Buffer | null;
  private readonly unavailableReason: string | null = null;

  constructor(private readonly configService: ConfigService) {
    const unavailable = this.configService.get<string>(
      ENCRYPTION_KEY_UNAVAILABLE_VAR,
    );
    if (unavailable) {
      this.unavailableReason = unavailable;
      this.resolvedKey = null;
      return;
    }
    this.resolvedKey = this.resolveEncryptionKey();
  }

  /**
   * The key, or the reason there is none. Thrown here rather than at boot: in
   * the CLI a locked vault must not stop commands that never open a secret.
   */
  private get encryptionKey(): Buffer {
    if (this.resolvedKey) return this.resolvedKey;
    throw new EncryptionKeyUnavailableError(
      this.unavailableReason ?? 'No encryption key is available.',
    );
  }

  /**
   * Resolve encryption key with 3-level fallback:
   * 1. Env var ENCRYPTION_KEY — K8s production (from Kubernetes Secret)
   * 2. File ~/.flui/encryption.key — local development of the API
   * 3. Generate that file
   *
   * The Flui CLI never reaches 2 or 3: it resolves the key from the vault
   * before starting this module and passes either ENCRYPTION_KEY or
   * FLUI_ENCRYPTION_KEY_UNAVAILABLE.
   */
  private resolveEncryptionKey(): Buffer {
    const envKey = this.configService.get<string>('ENCRYPTION_KEY');
    if (envKey) {
      const keyBuffer = Buffer.from(envKey, 'hex');
      if (keyBuffer.length !== 32) {
        throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
      }
      this.logger.debug('Using encryption key from environment');
      return keyBuffer;
    }

    const fluiDir = path.join(os.homedir(), '.flui');
    const keyFilePath = path.join(fluiDir, 'encryption.key');
    try {
      const fileKey = fs.readFileSync(keyFilePath, 'utf-8').trim();
      const keyBuffer = Buffer.from(fileKey, 'hex');
      if (keyBuffer.length !== 32) {
        throw new Error(
          `encryption.key file must contain 64 hex characters (32 bytes), got ${fileKey.length} chars`,
        );
      }
      this.logger.debug('Using encryption key from ~/.flui/encryption.key');
      return keyBuffer;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    this.logger.log(
      'No encryption key found. Generating new key at ~/.flui/encryption.key',
    );
    const newKey = crypto.randomBytes(32);
    if (!fs.existsSync(fluiDir)) {
      fs.mkdirSync(fluiDir, { recursive: true });
    }
    fs.writeFileSync(keyFilePath, newKey.toString('hex'), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return newKey;
  }

  /**
   * Raw DB encryption key for the platform recovery bundle (MVP-4). This key
   * decrypts EVERY `*Encrypted` column, so it may only be read to seal it into
   * an age-encrypted, operator-recipient bundle — never logged, never returned
   * to a client. The fingerprint lets callers audit which key was captured
   * without exposing the bytes.
   */
  exportKeyMaterialForBundle(): { keyHex: string; fingerprint: string } {
    return {
      keyHex: this.encryptionKey.toString('hex'),
      fingerprint: this.fingerprintOf(this.encryptionKey),
    };
  }

  /**
   * A key for a purpose that is not encryption, derived from the platform key
   * rather than taken from it.
   *
   * The MCP `requestState` needs an HMAC key. Reusing `encryptionKey` raw would
   * make one secret do two cryptographic jobs, which is how a weakness in one
   * becomes a weakness in the other; introducing a second secret would be
   * another thing to distribute, rotate and forget. HKDF-SHA256 with the
   * purpose as `info` gives each domain its own key material from the one
   * secret, and two domains can never collide.
   *
   * No salt: the input is already a high-entropy platform key, and a fixed
   * empty salt keeps the derivation reproducible across replicas — which it
   * must be, since any replica may verify what another minted.
   */
  deriveSubkey(domain: string, length = 32): Buffer {
    return Buffer.from(
      crypto.hkdfSync(
        'sha256',
        this.encryptionKey,
        Buffer.alloc(0),
        Buffer.from(`flui.subkey.${domain}`, 'utf8'),
        length,
      ),
    );
  }

  private fingerprintOf(key: Buffer): string {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  /**
   * Encrypt plaintext string using AES-256-GCM
   * @param plaintext String to encrypt
   * @returns Base64 encoded encrypted data (iv + authTag + encrypted)
   */
  encrypt(plaintext: string): string {
    const key = this.encryptionKey;
    try {
      return sealWithPlatformKey(key, plaintext);
    } catch (error) {
      this.logger.error('Encryption failed', error.stack);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt encrypted string
   * @param encryptedData Base64 encoded encrypted data
   * @returns Decrypted plaintext
   */
  decrypt(encryptedData: string): string {
    const key = this.encryptionKey;
    try {
      return openWithPlatformKey(key, encryptedData);
    } catch (error) {
      this.logger.error('Decryption failed', error.stack);
      throw new Error('Failed to decrypt data');
    }
  }

  generateRandomToken(length = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Generate a secure K3s token for cluster authentication
   *
   * K3s accepts "short token" format: a simple password (minimum 10 characters)
   * We generate 128 characters using a mix of:
   * - Lowercase letters (a-z)
   * - Uppercase letters (A-Z)
   * - Numbers (0-9)
   * - Safe special characters (-_@.+:=)
   *
   * These characters are safe for use in bash scripts, YAML, and K3s configuration.
   *
   * Provides ~778 bits of entropy (practically unbreakable)
   *
   * @returns A 128-character secure token
   */
  generateK3sToken(): string {
    // Character set: lowercase + uppercase + numbers + safe specials (70 chars total)
    const charset =
      'abcdefghijklmnopqrstuvwxyz' + // 26 chars
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + // 26 chars
      '0123456789' + // 10 chars
      '-_@.+:='; // 7 safe special chars (no problematic bash/shell chars)

    const tokenLength = 128;
    const randomBytes = crypto.randomBytes(tokenLength);

    let token = '';
    for (let i = 0; i < tokenLength; i++) {
      // Use modulo to map random byte to charset index
      token += charset[randomBytes[i] % charset.length];
    }

    return token;
  }

  hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  compareHash(plaintext: string, hash: string): boolean {
    const plaintextHash = this.hashPassword(plaintext);
    return crypto.timingSafeEqual(
      Buffer.from(plaintextHash),
      Buffer.from(hash),
    );
  }
}
