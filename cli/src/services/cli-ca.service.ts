import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { CaSealedError, SealedCa } from '../lib/vault/sealed-ca';
import { VaultNotInitialisedError } from '../lib/vault/vault-file';

/**
 * CLI SSH Certificate Authority (CA) Management Service
 *
 * Manages SSH CA for secure server access with ephemeral certificates:
 * - Generates ED25519 SSH CA keypair if not exists
 * - Keeps the private key sealed in the vault (~/.flui/profiles/<profile>/ca/ca_key.sealed)
 * - Signs ephemeral SSH certificates for server access
 * - Provides enrollment script for server CA installation
 * - One CA per CLI installation (shared across all clusters)
 */
@Injectable()
export class CliCaService {
  private readonly logger = new Logger(CliCaService.name);
  private readonly ca = new SealedCa();
  private readonly caPubKeyPath = this.ca.publicKeyPath;

  async getOrCreateCaCertificate(): Promise<{ publicKey: string }> {
    if (this.ca.exists()) {
      this.logger.debug('Using existing SSH CA certificate');
      return { publicKey: this.ca.publicKey() };
    }

    this.logger.log('Generating new SSH CA certificate for Flui clusters...');
    try {
      const publicKey = this.ca.create();
      this.logger.log('SSH CA certificate generated and sealed in the vault');
      return { publicKey };
    } catch (error) {
      if (
        error instanceof CaSealedError ||
        error instanceof VaultNotInitialisedError
      ) {
        throw error;
      }
      this.logger.error('Failed to generate SSH CA certificate:', error);
      throw new Error(`SSH CA certificate generation failed: ${error.message}`);
    }
  }

  async getCaPublicKey(): Promise<string> {
    const { publicKey } = await this.getOrCreateCaCertificate();
    return publicKey;
  }

  async getCaPrivateKey(): Promise<string> {
    await this.getOrCreateCaCertificate();
    return this.ca.privateKey().trim();
  }

  /**
   * Sign a public key to create an ephemeral certificate
   *
   * @param publicKey - SSH public key to sign
   * @param validitySeconds - Certificate validity in seconds (default: 300 = 5 minutes)
   * @param principals - Principals (usernames) the certificate is valid for
   * @returns Signed certificate content
   */
  async signPublicKey(
    publicKey: string,
    validitySeconds: number = 300,
    principals: string[] = ['root', 'ubuntu', 'admin'],
  ): Promise<string> {
    await this.getOrCreateCaCertificate();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flui-cert-'));
    fs.chmodSync(tempDir, 0o700);

    try {
      const pubKeyPath = path.join(tempDir, 'key.pub');
      const certPath = path.join(tempDir, 'key-cert.pub');
      fs.writeFileSync(pubKeyPath, publicKey, { mode: 0o644 });

      const result = this.ca.withPrivateKeyFile((caKeyPath) =>
        spawnSync(
          'ssh-keygen',
          [
            '-s',
            caKeyPath,
            '-I',
            'flui-ephemeral-cert',
            '-n',
            principals.join(','),
            '-V',
            `+${validitySeconds}s`,
            pubKeyPath,
          ],
          { stdio: 'pipe' },
        ),
      );
      if (result.status !== 0) {
        throw new Error(
          result.stderr?.toString().trim() ||
            `ssh-keygen exited with ${result.status}`,
        );
      }

      const certificate = fs.readFileSync(certPath, 'utf-8').trim();
      this.logger.debug(
        `Signed ephemeral certificate valid for ${validitySeconds}s`,
      );
      return certificate;
    } catch (error) {
      if (
        error instanceof CaSealedError ||
        error instanceof VaultNotInitialisedError
      ) {
        throw error;
      }
      this.logger.error('Failed to sign public key:', error);
      throw new Error(`Certificate signing failed: ${error.message}`);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        this.logger.warn(`Failed to cleanup temp directory: ${tempDir}`);
      }
    }
  }

  /**
   * Get enrollment script that installs CA on a server
   * This script should be included in cloud-init or run manually on servers
   */
  async getEnrollmentScript(): Promise<string> {
    const caPublicKey = await this.getCaPublicKey();

    return `#!/bin/bash
# Flui SSH CA Enrollment Script
# This script installs the Flui SSH CA certificate on a server
# for certificate-based authentication

set -e

CA_PUBLIC_KEY="${caPublicKey}"
CA_KEYS_FILE="/etc/ssh/trusted_user_ca_keys"

echo "Installing Flui SSH CA certificate..."

# Write CA public key to file
echo "$CA_PUBLIC_KEY" > "$CA_KEYS_FILE"
chmod 644 "$CA_KEYS_FILE"

echo "CA public key installed to: $CA_KEYS_FILE"

# Configure SSH to trust the CA
if ! grep -q "^TrustedUserCAKeys" /etc/ssh/sshd_config; then
  echo "TrustedUserCAKeys $CA_KEYS_FILE" >> /etc/ssh/sshd_config
  echo "Configured SSH to trust CA certificates"
else
  echo "TrustedUserCAKeys already configured"
fi

# Disable password authentication (security best practice)
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config

echo "Password authentication disabled"

# Restart SSH service
if systemctl is-active --quiet ssh; then
  systemctl reload ssh
  echo "SSH service reloaded"
elif systemctl is-active --quiet sshd; then
  systemctl reload sshd
  echo "SSH service reloaded"
else
  echo "WARNING: Could not reload SSH service"
fi

echo "Flui SSH CA enrollment completed successfully!"
`;
  }

  /**
   * Get CA certificate info
   */
  async getCaInfo(): Promise<{
    algorithm: string;
    fingerprint: string;
    comment: string;
  }> {
    if (!fs.existsSync(this.caPubKeyPath)) {
      throw new Error(
        'CA public key not found. Run getOrCreateCaCertificate() first.',
      );
    }

    try {
      // Get key fingerprint
      const fingerprintOutput = execFileSync(
        'ssh-keygen',
        ['-lf', this.caPubKeyPath],
        { encoding: 'utf-8' },
      );

      // Parse output: "256 SHA256:abc... flui-ca-cli (ED25519)"
      const parts = fingerprintOutput.trim().split(' ');
      const fingerprint = parts[1] || 'Unknown';
      const comment = parts[2] || 'Unknown';
      const algorithm = parts[3]?.replaceAll(/[()]/g, '') || 'ED25519';

      return {
        algorithm,
        fingerprint,
        comment,
      };
    } catch (error) {
      this.logger.error('Failed to get CA info:', error);
      throw error;
    }
  }

  /**
   * Get CA public key path
   */
  getCaPubKeyPath(): string {
    if (!fs.existsSync(this.caPubKeyPath)) {
      throw new Error(
        'CA public key not found. Run getOrCreateCaCertificate() first.',
      );
    }
    return this.caPubKeyPath;
  }
}
