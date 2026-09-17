import { Injectable, Logger } from '@nestjs/common';
import { SSHKeyGeneratorService } from './ssh-key-generator.service';
import { CAManagerService } from './ca-manager.service';
import { promises as fs } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Longest life a certificate minted here may be given.
 *
 * These certificates carry `root` and cannot be revoked: there is no KRL, so a
 * long-lived one is only killed by rotating the CA on every node that trusts
 * it. The ceiling is what keeps a mistyped or hostile TTL from outliving the
 * cluster it opens.
 */
export const MAX_CERTIFICATE_TTL_SECONDS = 600;

/**
 * Internal interface for ephemeral certificates
 * Not exposed via REST API
 * @internal
 */
export interface EphemeralCertificate {
  certificate: string;
  privateKey: string;
  publicKey: string;
  fingerprint: string;
  expiresAt: Date;
  tenantId?: string;
}

/**
 * Internal service for generating ephemeral SSH certificates
 * Used only by the terminal service for WebSocket SSH connections
 * @internal
 */
@Injectable()
export class CertificateSignerService {
  private readonly logger = new Logger(CertificateSignerService.name);

  constructor(
    private readonly keyGenerator: SSHKeyGeneratorService,
    private readonly caManager: CAManagerService,
  ) {}

  /**
   * Generate ephemeral certificate for internal SSH connections
   * This is ONLY called internally by the terminal service
   * Never expose this via REST API as it returns private keys
   */
  async generateEphemeralCertificate(
    tenantId?: string,
    ttlSeconds: number = 180,
  ): Promise<EphemeralCertificate> {
    this.logger.debug(
      `Generating ephemeral certificate for tenant ${tenantId || 'global'}, TTL: ${ttlSeconds}s`,
    );

    // Generate ephemeral keypair (never stored, only in memory)
    const ephemeralKeyPair = await this.keyGenerator.generateKeyPair('ed25519');

    // Get CA private key for this tenant
    const caPrivateKey = await this.caManager.getCAPrivateKey(tenantId);

    // Standard principals for server access
    const principals = ['root', 'ubuntu', 'admin'];

    // Sign the ephemeral public key with tenant's CA
    const certificate = await this.signPublicKeyWithCA(
      ephemeralKeyPair.publicKey,
      caPrivateKey,
      principals,
      ttlSeconds,
    );

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + ttlSeconds);

    return {
      certificate,
      privateKey: ephemeralKeyPair.privateKey,
      publicKey: ephemeralKeyPair.publicKey,
      fingerprint: ephemeralKeyPair.fingerprint,
      expiresAt,
      tenantId,
    };
  }

  /**
   * Sign public key with CA (internal helper)
   */
  private async signPublicKeyWithCA(
    publicKey: string,
    caPrivateKey: string,
    principals: string[],
    validitySeconds: number,
  ): Promise<string> {
    let tempDir: string | null = null;

    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flui-ca-'));

      const caKeyPath = path.join(tempDir, 'ca');
      const pubKeyPath = path.join(tempDir, 'ephemeral.pub');
      const certPath = path.join(tempDir, 'ephemeral-cert.pub');

      await fs.writeFile(caKeyPath, caPrivateKey, { mode: 0o600 });
      await fs.writeFile(pubKeyPath, publicKey);

      const principalsStr = principals.join(',');
      const timestamp = Date.now();

      // Arguments as an array, never a shell string: the validity and the
      // principals reach here from request input, and a shell would read them
      // as syntax. Today a coercion upstream happens to make that harmless,
      // which is not the same as it being safe.
      const args = [
        '-s',
        caKeyPath,
        '-I',
        `flui-ephemeral-${timestamp}`,
        '-n',
        principalsStr,
        '-V',
        `+${validitySeconds}s`,
        pubKeyPath,
      ];

      this.logger.debug(`Executing ssh-keygen signing command...`);

      const { stdout, stderr } = await execFileAsync('ssh-keygen', args, {
        cwd: tempDir,
      });
      if (stdout) this.logger.debug(`ssh-keygen stdout: ${stdout}`);
      if (stderr) this.logger.debug(`ssh-keygen stderr: ${stderr}`);

      // Read the generated certificate
      const certificate = await fs.readFile(certPath, 'utf-8');
      const certStats = await fs.stat(certPath);

      this.logger.debug(`Certificate file size: ${certStats.size} bytes`);
      this.logger.debug(
        `Certificate preview (first 200 chars): ${certificate.substring(0, 200)}...`,
      );

      // Validate the certificate using ssh-keygen -L
      try {
        const validateCommand = `ssh-keygen -L -f "${certPath}"`;
        const { stdout: certInfo } = await execAsync(validateCommand, {
          cwd: tempDir,
        });
        this.logger.debug(`Certificate validation info:\n${certInfo}`);
      } catch (validateError) {
        this.logger.warn(
          `Failed to validate certificate: ${validateError.message}`,
        );
      }

      return certificate.trim();
    } catch (error) {
      this.logger.error('Failed to sign certificate:', error.message);
      throw error;
    } finally {
      if (tempDir) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to cleanup temp directory: ${cleanupError.message}`,
          );
        }
      }
    }
  }
}
