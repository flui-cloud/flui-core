import { Injectable, Logger } from '@nestjs/common';
import { spawn, ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SSHCredentials {
  privateKey: string;
  /** Optional — when absent, standard public-key auth is used (no certificate) */
  certificate?: string;
}

export interface SSHConnectionOptions {
  rows?: number;
  cols?: number;
}

export interface SSHConnection {
  process: ChildProcess;
  cleanup: () => Promise<void>;
}

/**
 * Service for managing native SSH connections with certificate support
 * Uses native SSH command instead of ssh2 library to support SSH certificates
 */
@Injectable()
export class NativeSSHConnectionService {
  private readonly logger = new Logger(NativeSSHConnectionService.name);

  /**
   * Create a native SSH connection with certificate authentication
   *
   * @param host - Server IP or hostname
   * @param username - SSH username (typically 'root')
   * @param credentials - Private key and certificate
   * @param onData - Callback for stdout data
   * @param onError - Callback for errors
   * @param onClose - Callback when connection closes
   * @param options - Connection options (terminal size)
   * @returns SSH connection object with cleanup function
   */
  async createConnection(
    host: string,
    username: string,
    credentials: SSHCredentials,
    onData: (data: string) => void,
    onError: (error: Error) => void,
    onClose: () => void,
    options?: SSHConnectionOptions,
  ): Promise<SSHConnection> {
    let tempDir: string | null = null;

    try {
      // Create temporary directory for credentials
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flui-ssh-'));
      this.logger.debug(`Created temp directory: ${tempDir}`);

      // Write private key to temp file
      const keyPath = path.join(tempDir, 'key');
      await fs.writeFile(keyPath, credentials.privateKey, { mode: 0o600 });
      this.logger.debug(`Wrote key: ${keyPath}`);

      // Write certificate only if provided (ephemeral cert mode)
      const certArgs: string[] = [];
      if (credentials.certificate) {
        const certPath = path.join(tempDir, 'key-cert.pub');
        await fs.writeFile(certPath, credentials.certificate, { mode: 0o644 });
        this.logger.debug(`Wrote cert: ${certPath}`);
        certArgs.push('-o', `CertificateFile=${certPath}`);
      }

      // Spawn native SSH process
      this.logger.log(
        `🔌 Spawning native SSH connection to ${username}@${host} (${credentials.certificate ? 'certificate auth' : 'publickey auth'})`,
      );

      const rows = options?.rows || 24;
      const cols = options?.cols || 80;

      this.logger.log(`📏 Terminal size: ${cols}x${rows}`);

      const sshProcess = spawn(
        'ssh',
        [
          '-i',
          keyPath,
          ...certArgs,
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'ServerAliveInterval=30',
          '-o',
          'ServerAliveCountMax=3',
          '-o',
          'LogLevel=ERROR',
          '-tt', // Force PTY allocation (double -t for better compatibility)
          `${username}@${host}`,
        ],
        {
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLUMNS: cols.toString(),
            LINES: rows.toString(),
          },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );

      // Terminal size is set via COLUMNS and LINES environment variables above
      // No need to send stty command which can interfere with SSH authentication

      // Handle stdout
      sshProcess.stdout?.on('data', (data: Buffer) => {
        const str = data.toString('utf-8');
        this.logger.debug(`📤 Received ${str.length} chars from stdout`);
        onData(str);
      });

      // Handle stderr
      sshProcess.stderr?.on('data', (data: Buffer) => {
        const str = data.toString('utf-8');
        this.logger.debug(`📤 Received ${str.length} chars from stderr`);
        this.logger.debug(`📤 stderr content: ${str}`);
        // SSH protocol messages go to stderr, pass to onData
        onData(str);
      });

      // Handle process exit
      sshProcess.on('close', async (code, signal) => {
        this.logger.log(
          `SSH process closed (code: ${code}, signal: ${signal})`,
        );

        // Cleanup temp files
        if (tempDir) {
          try {
            await fs.rm(tempDir, { recursive: true, force: true });
            this.logger.debug(`Cleaned up temp directory: ${tempDir}`);
          } catch (cleanupError) {
            this.logger.warn(
              `Failed to cleanup temp dir: ${cleanupError.message}`,
            );
          }
        }

        onClose();
      });

      // Handle process errors
      sshProcess.on('error', (error) => {
        this.logger.error(`SSH process error: ${error.message}`);
        onError(error);
      });

      // Cleanup function
      const cleanup = async () => {
        this.logger.log('🧹 Cleaning up SSH connection...');

        // Kill process if still running
        if (sshProcess && !sshProcess.killed) {
          sshProcess.kill('SIGTERM');
          this.logger.debug('SSH process killed');
        }

        // Remove temp directory
        if (tempDir) {
          try {
            await fs.rm(tempDir, { recursive: true, force: true });
            this.logger.debug(`Cleaned up temp directory: ${tempDir}`);
          } catch (cleanupError) {
            this.logger.warn(
              `Failed to cleanup temp dir: ${cleanupError.message}`,
            );
          }
        }
      };

      return {
        process: sshProcess,
        cleanup,
      };
    } catch (error) {
      this.logger.error(`Failed to create SSH connection: ${error.message}`);

      // Cleanup on error
      if (tempDir) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to cleanup temp dir on error: ${cleanupError.message}`,
          );
        }
      }

      throw error;
    }
  }

  /**
   * Execute a single command over SSH and return stdout.
   */
  async execCommand(
    host: string,
    username: string,
    privateKey: string,
    command: string,
    timeoutMs = 30000,
    options?: { certificate?: string; port?: number },
  ): Promise<string> {
    let tempDir: string | null = null;
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flui-ssh-exec-'));
      const keyPath = path.join(tempDir, 'key');
      await fs.writeFile(keyPath, privateKey, { mode: 0o600 });

      const certArgs: string[] = [];
      if (options?.certificate) {
        const certPath = path.join(tempDir, 'key-cert.pub');
        await fs.writeFile(certPath, options.certificate, { mode: 0o644 });
        certArgs.push('-o', `CertificateFile=${certPath}`);
      }
      const portArgs = options?.port ? ['-p', String(options.port)] : [];

      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`SSH exec timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );

        const proc = spawn(
          'ssh',
          [
            '-i',
            keyPath,
            ...certArgs,
            ...portArgs,
            '-o',
            'StrictHostKeyChecking=no',
            '-o',
            'UserKnownHostsFile=/dev/null',
            '-o',
            'LogLevel=ERROR',
            '-o',
            'ConnectTimeout=10',
            `${username}@${host}`,
            command,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        );

        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
        proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(
              new Error(`SSH exec failed (code ${code}): ${stderr.trim()}`),
            );
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * Write data to SSH stdin
   */
  writeData(sshProcess: ChildProcess, data: string): void {
    if (sshProcess.stdin?.writable) {
      sshProcess.stdin.write(data);
      this.logger.debug(
        `✍️ Wrote ${data.length} chars to SSH stdin: ${JSON.stringify(data.substring(0, 20))}`,
      );
    } else {
      this.logger.error('❌ SSH stdin is not writable');
      throw new Error('SSH stdin is not writable');
    }
  }

  /**
   * Resize terminal using stty command
   * Sends stty command to the remote shell to update terminal size
   */
  resizeTerminal(sshProcess: ChildProcess, rows: number, cols: number): void {
    if (sshProcess.stdin?.writable) {
      // \x15 = Ctrl+U clears the current input line (no echo)
      // stty updates the PTY dimensions on the remote shell
      // \x0c = Ctrl+L triggers a silent screen redraw (no visible command)
      sshProcess.stdin.write(`\x15stty rows ${rows} cols ${cols}\r`);
      // Small delay to let stty complete, then redraw cleanly
      setTimeout(() => {
        if (sshProcess.stdin?.writable) {
          sshProcess.stdin.write('\x0c');
        }
      }, 50);
      this.logger.debug(`Terminal resized to ${cols}x${rows}`);
    } else {
      this.logger.warn(`Cannot resize terminal - stdin not writable`);
    }
  }
}
