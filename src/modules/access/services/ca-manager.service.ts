import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CAKeypairEntity } from '../entities/ca-keypair.entity';
import { SSHKeyGeneratorService } from './ssh-key-generator.service';
import { KeyStorageService } from './key-storage.service';
import * as crypto from 'node:crypto';
import { promises as fsPromises, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

@Injectable()
export class CAManagerService {
  private readonly logger = new Logger(CAManagerService.name);

  constructor(
    @InjectRepository(CAKeypairEntity)
    private readonly caRepository: Repository<CAKeypairEntity>,
    private readonly keyGenerator: SSHKeyGeneratorService,
    private readonly keyStorage: KeyStorageService,
  ) {}

  async initializeCA(): Promise<CAKeypairEntity> {
    throw new ConflictException(
      'API CA initialization is disabled. SSH CA is managed by the CLI (~/.flui/ca/) ' +
        'and shared with the API via environment variable or file. ' +
        'Use "flui env:create" to set up the SSH CA.',
    );
  }

  async getActiveCA(): Promise<CAKeypairEntity | null> {
    return await this.caRepository.findOne({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Resolves the CLI CA directory for the active profile.
   * Priority: FLUI_PROFILE env var > ~/.flui/context file > 'default'
   * Path: ~/.flui/profiles/<profile>/ca/
   */
  private getCliCaDir(): string {
    const baseDir = path.join(os.homedir(), '.flui');
    const profilesDir = path.join(baseDir, 'profiles');

    let profile = process.env.FLUI_PROFILE;
    if (!profile) {
      const contextFile = path.join(baseDir, 'context');
      try {
        profile = readFileSync(contextFile, 'utf-8').trim() || 'default';
      } catch {
        profile = 'default';
      }
    }

    return path.join(profilesDir, profile, 'ca');
  }

  async getCAPrivateKey(tenantId?: string): Promise<string> {
    // 1. Kubernetes Secret (env var) — production K8s deployment
    const envCaKey = process.env.SSH_CA_PRIVATE_KEY;
    if (envCaKey) {
      this.logger.debug('Using CLI CA private key from environment');
      // SSH private keys MUST end with a newline
      return envCaKey.replaceAll(String.raw`\r\n`, '\n').trimEnd() + '\n';
    }

    // 2. CLI CA file — local development (profile-aware: ~/.flui/profiles/<profile>/ca/ca_key)
    const caKeyPath = path.join(this.getCliCaDir(), 'ca_key');
    try {
      const fileKey = await fsPromises.readFile(caKeyPath, 'utf-8');
      this.logger.debug(`Using CLI CA private key from ${caKeyPath}`);
      // SSH private keys MUST end with a newline — normalize but preserve it
      return fileKey.replaceAll(String.raw`\r\n`, '\n').trimEnd() + '\n';
    } catch {
      // File not found, continue to database fallback
    }

    // 3. Database CA — legacy fallback
    // 503, not 404: the CA is a dependency of this server, not a resource the
    // caller asked for. A 404 reads as permanent and stops callers from
    // retrying while the key is still being seeded.
    const ca = await this.getActiveCA();
    if (!ca) {
      throw new ServiceUnavailableException(
        `No active CA found. Set SSH_CA_PRIVATE_KEY env var, place key in ${caKeyPath}, or initialize CA.`,
      );
    }

    if (!ca.encryptedPrivateKey) {
      throw new ServiceUnavailableException('CA private key not available.');
    }

    return this.keyStorage.decryptKeyFromString(ca.encryptedPrivateKey);
  }

  async getCAPublicKey(tenantId?: string): Promise<string> {
    // 1. Env var — production K8s deployment
    const envCaPubKey = process.env.SSH_CA_PUBLIC_KEY;
    if (envCaPubKey) return envCaPubKey;

    // 2. CLI CA file — local development (profile-aware: ~/.flui/profiles/<profile>/ca/ca_key.pub)
    const caPubKeyPath = path.join(this.getCliCaDir(), 'ca_key.pub');
    try {
      const filePubKey = await fsPromises.readFile(caPubKeyPath, 'utf-8');
      this.logger.debug(`Using CLI CA public key from ${caPubKeyPath}`);
      return filePubKey.trim();
    } catch {
      // File not found, continue to database fallback
    }

    // 3. Database — legacy fallback
    const ca = await this.getActiveCA();
    if (!ca) {
      throw new NotFoundException('No active CA found.');
    }

    return ca.publicKey;
  }

  async getCAInfo(): Promise<CAKeypairEntity> {
    const ca = await this.getActiveCA();
    if (!ca) {
      throw new NotFoundException('No active CA found. Initialize CA first.');
    }

    return ca;
  }

  async getEnrollmentScript(tenantId?: string): Promise<string> {
    // Use default CA for now (no tenantId passed)
    const caPublicKey = await this.getCAPublicKey(tenantId);

    return `#!/bin/bash
set -e

echo "=== Flui.cloud SSH CA Enrollment ==="

# Backup existing sshd_config
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.$(date +%s)

# Install CA public key
echo "${caPublicKey}" > /etc/ssh/trusted_user_ca_keys
chmod 644 /etc/ssh/trusted_user_ca_keys

echo "✓ CA public key installed"

# Configure sshd to trust CA
if ! grep -q "^TrustedUserCAKeys" /etc/ssh/sshd_config; then
  echo "TrustedUserCAKeys /etc/ssh/trusted_user_ca_keys" >> /etc/ssh/sshd_config
  echo "✓ TrustedUserCAKeys configured"
else
  echo "⊙ TrustedUserCAKeys already configured"
fi

# Disable password authentication (security hardening)
sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
echo "✓ Password authentication disabled"

# Reload SSH daemon
if systemctl reload sshd 2>/dev/null; then
  echo "✓ SSH daemon reloaded (sshd)"
elif systemctl reload ssh 2>/dev/null; then
  echo "✓ SSH daemon reloaded (ssh)"
else
  echo "⚠ Could not reload SSH daemon. Manual restart may be required."
  exit 1
fi

echo "=== Enrollment completed successfully ==="
`;
  }

  /**
   * Register an external CA public key (from CLI)
   * @param publicKey - SSH CA public key in OpenSSH format
   * @param options - Registration options (name, replace, metadata)
   */
  async registerExternalCA(
    publicKey: string,
    options: {
      name?: string;
      replace?: boolean;
      metadata?: Record<string, any>;
      privateKey?: string;
    } = {},
  ): Promise<CAKeypairEntity> {
    this.logger.log('Registering external CA public key...');

    // Validate public key format
    const trimmedKey = publicKey.trim();
    if (
      !trimmedKey.startsWith('ssh-ed25519 ') &&
      !trimmedKey.startsWith('ssh-rsa ')
    ) {
      throw new BadRequestException(
        'Invalid public key format. Must start with ssh-ed25519 or ssh-rsa',
      );
    }

    // Extract key type
    const keyType = trimmedKey.startsWith('ssh-ed25519') ? 'ed25519' : 'rsa';

    // Compute fingerprint
    const fingerprint = this.computeFingerprint(trimmedKey, keyType);

    // Check for existing CA
    const existingCA = await this.getActiveCA();

    if (existingCA) {
      // Check if it's the same CA (by fingerprint)
      if (existingCA.fingerprint === fingerprint) {
        throw new ConflictException(
          `CA with fingerprint ${fingerprint} is already registered`,
        );
      }

      // If replace flag is not set, throw error
      if (!options.replace) {
        throw new ConflictException(
          'CA already exists. Use replace=true to replace existing CA.',
        );
      }

      // Deactivate existing CA
      this.logger.log(`Deactivating existing CA: ${existingCA.name}`);
      existingCA.isActive = false;
      await this.caRepository.save(existingCA);
    }

    // Generate name if not provided
    const name =
      options.name || `flui-ca-${new Date().toISOString().split('T')[0]}`;

    const encryptedPrivateKey = options.privateKey
      ? this.keyStorage.encryptKeyToString(
          options.privateKey.replaceAll(String.raw`\r\n`, '\n').trimEnd() +
            '\n',
        )
      : null;

    const ca = this.caRepository.create({
      name,
      publicKey: trimmedKey,
      encryptedPrivateKey,
      fingerprint,
      type: keyType,
      isActive: true,
      expiresAt: null,
      // Store metadata if provided
      ...(options.metadata && { metadata: options.metadata }),
    });

    const saved = await this.caRepository.save(ca);
    this.logger.log(
      `External CA registered: ${saved.name} (${saved.fingerprint})`,
    );

    return saved;
  }

  /**
   * Backfill the encrypted private key on an existing CA row that was
   * originally seeded with only the public half. Used by the bootstrap
   * seeder so once SSH_CA_PRIVATE_KEY appears in the environment the DB
   * row becomes self-sufficient and survives even when the env var is no
   * longer mounted.
   */
  async attachPrivateKey(caId: string, privateKey: string): Promise<void> {
    const ca = await this.caRepository.findOne({ where: { id: caId } });
    if (!ca) {
      throw new NotFoundException(`CA ${caId} not found`);
    }
    ca.encryptedPrivateKey = this.keyStorage.encryptKeyToString(
      privateKey.replaceAll(String.raw`\r\n`, '\n').trimEnd() + '\n',
    );
    await this.caRepository.save(ca);
    this.logger.log(`CA ${ca.name} private key attached`);
  }

  /**
   * Compute SHA256 fingerprint for a public key
   * @param publicKey - OpenSSH format public key
   * @param keyType - Key type (ed25519 or rsa)
   */
  private computeFingerprint(publicKey: string, keyType: string): string {
    // Extract the base64 part (second field in OpenSSH format)
    const parts = publicKey.trim().split(' ');
    if (parts.length < 2) {
      throw new BadRequestException('Invalid public key format');
    }

    const keyData = parts[1];
    const keyBuffer = Buffer.from(keyData, 'base64');

    // Compute SHA256 hash
    const hash = crypto.createHash('sha256').update(keyBuffer).digest('base64');

    return `SHA256:${hash.replace(/=+$/, '')}`; // Remove trailing =
  }
}
