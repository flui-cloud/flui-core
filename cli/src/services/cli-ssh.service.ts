import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { CliCaService } from './cli-ca.service';

/**
 * CLI SSH Management Service
 *
 * Manages SSH access with ephemeral certificates:
 * - Generates ephemeral ED25519 keypair for each connection
 * - Gets certificate signed by CA (5-minute validity)
 * - Uses certificate for SSH authentication
 * - Cleans up temporary files after connection
 */
@Injectable()
export class CliSshService {
  private readonly logger = new Logger(CliSshService.name);
  private readonly fluiDir = path.join(os.homedir(), '.flui');
  private readonly sshDir = path.join(this.fluiDir, 'ssh');
  private readonly privateKeyPath = path.join(this.sshDir, 'id_rsa');
  private readonly publicKeyPath = path.join(this.sshDir, 'id_rsa.pub');

  constructor(private readonly caService: CliCaService) {
    this.ensureSshDir();
  }

  /**
   * Ensure ~/.flui/ssh directory exists
   */
  private ensureSshDir(): void {
    if (!fs.existsSync(this.sshDir)) {
      fs.mkdirSync(this.sshDir, { recursive: true, mode: 0o700 });
      this.logger.log(`Created SSH directory: ${this.sshDir}`);
    }
  }

  /**
   * Get or generate SSH key pair
   * Returns the public key content for server provisioning
   */
  async getOrCreateSshKey(): Promise<{
    publicKey: string;
    privateKeyPath: string;
    publicKeyPath: string;
  }> {
    // Check if key already exists
    if (
      fs.existsSync(this.privateKeyPath) &&
      fs.existsSync(this.publicKeyPath)
    ) {
      this.logger.debug('Using existing SSH key');
      const publicKey = fs.readFileSync(this.publicKeyPath, 'utf-8').trim();
      return {
        publicKey,
        privateKeyPath: this.privateKeyPath,
        publicKeyPath: this.publicKeyPath,
      };
    }

    // Generate new SSH key pair
    this.logger.log('Generating new SSH key pair for Flui CLI...');

    try {
      // Use ssh-keygen to generate key pair
      spawnSync(
        'ssh-keygen',
        [
          '-t',
          'rsa',
          '-b',
          '4096',
          '-f',
          this.privateKeyPath,
          '-N',
          '',
          '-C',
          `flui-cli@${os.hostname()}`,
        ],
        { stdio: 'pipe' },
      );

      // Set correct permissions
      fs.chmodSync(this.privateKeyPath, 0o600);
      fs.chmodSync(this.publicKeyPath, 0o644);

      const publicKey = fs.readFileSync(this.publicKeyPath, 'utf-8').trim();

      this.logger.log('SSH key pair generated successfully');
      this.logger.log(`Private key: ${this.privateKeyPath}`);
      this.logger.log(`Public key: ${this.publicKeyPath}`);

      return {
        publicKey,
        privateKeyPath: this.privateKeyPath,
        publicKeyPath: this.publicKeyPath,
      };
    } catch (error) {
      this.logger.error('Failed to generate SSH key:', error);
      throw new Error(`SSH key generation failed: ${error.message}`);
    }
  }

  /**
   * Get SSH public key content
   */
  async getPublicKey(): Promise<string> {
    const { publicKey } = await this.getOrCreateSshKey();
    return publicKey;
  }

  /**
   * Get SSH private key path for SSH connections
   */
  getPrivateKeyPath(): string {
    if (!fs.existsSync(this.privateKeyPath)) {
      throw new Error(
        'SSH private key not found. Run getOrCreateSshKey() first.',
      );
    }
    return this.privateKeyPath;
  }

  /**
   * Generate ephemeral keypair and get signed certificate
   * Returns paths to private key and certificate
   */
  private async generateEphemeralKeypair(): Promise<{
    privateKeyPath: string;
    publicKeyPath: string;
    certificatePath: string;
    cleanup: () => void;
  }> {
    const tempDir = path.join(os.tmpdir(), `flui-ephemeral-${Date.now()}`);
    fs.mkdirSync(tempDir, { mode: 0o700 });

    const privateKeyPath = path.join(tempDir, 'ephemeral_key');
    const publicKeyPath = `${privateKeyPath}.pub`;
    const certificatePath = `${privateKeyPath}-cert.pub`;

    this.logger.debug('Generating ephemeral SSH keypair...');

    // Generate ED25519 keypair
    spawnSync(
      'ssh-keygen',
      ['-t', 'ed25519', '-f', privateKeyPath, '-N', '', '-C', 'flui-ephemeral'],
      { stdio: 'pipe' },
    );

    // Set permissions
    fs.chmodSync(privateKeyPath, 0o600);
    fs.chmodSync(publicKeyPath, 0o644);

    // Read public key
    const publicKey = fs.readFileSync(publicKeyPath, 'utf-8').trim();

    // Get certificate signed by CA (5-minute validity)
    this.logger.debug('Signing ephemeral key with CA...');
    const certificate = await this.caService.signPublicKey(publicKey, 300);

    // Write certificate
    fs.writeFileSync(certificatePath, certificate, { mode: 0o644 });

    this.logger.debug(`Ephemeral certificate created: ${certificatePath}`);

    return {
      privateKeyPath,
      publicKeyPath,
      certificatePath,
      cleanup: () => {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
          this.logger.debug(`Cleaned up ephemeral keys: ${tempDir}`);
        } catch {
          this.logger.warn(`Failed to cleanup ephemeral keys: ${tempDir}`);
        }
      },
    };
  }

  /**
   * SSH into a server using ephemeral certificate
   */
  async sshConnect(
    host: string,
    username: string = 'root',
    port = 22,
  ): Promise<void> {
    const { privateKeyPath, certificatePath, cleanup } =
      await this.generateEphemeralKeypair();

    this.logger.log(
      `Connecting to ${username}@${host}:${port} with ephemeral certificate...`,
    );

    try {
      const result = spawnSync(
        'ssh',
        [
          '-i',
          privateKeyPath,
          '-p',
          String(port),
          '-o',
          `CertificateFile=${certificatePath}`,
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'PasswordAuthentication=no',
          '-o',
          'PubkeyAuthentication=yes',
          '-o',
          'PreferredAuthentications=publickey',
          `${username}@${host}`,
        ],
        { stdio: 'inherit' },
      );

      // 0 = clean exit, 130 = Ctrl+C (SIGINT) — both are graceful
      const isGraceful =
        result.status === 0 ||
        result.status === 130 ||
        result.signal === 'SIGINT';

      if (!isGraceful) {
        throw new Error(
          `SSH exited with code ${result.status ?? result.signal}`,
        );
      }
    } finally {
      cleanup();
    }
  }

  /**
   * Execute command on remote server via SSH with ephemeral certificate
   */
  async sshExec(
    host: string,
    command: string,
    username: string = 'root',
    port = 22,
  ): Promise<string> {
    const { privateKeyPath, certificatePath, cleanup } =
      await this.generateEphemeralKeypair();

    try {
      const result = spawnSync(
        'ssh',
        [
          '-i',
          privateKeyPath,
          '-p',
          String(port),
          '-o',
          `CertificateFile=${certificatePath}`,
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'PasswordAuthentication=no',
          '-o',
          'PubkeyAuthentication=yes',
          '-o',
          'PreferredAuthentications=publickey',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=10',
          '-o',
          'ServerAliveInterval=5',
          '-o',
          'ServerAliveCountMax=2',
          `${username}@${host}`,
          command,
        ],
        { encoding: 'utf-8', timeout: 30_000 },
      );

      if (
        result.error &&
        (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      ) {
        throw new Error(`SSH command timed out after 30s on ${host}`);
      }

      if (result.status !== 0) {
        const errMsg =
          result.stderr?.trim() || `SSH exited with code ${result.status}`;
        throw new Error(`Command failed: ${errMsg}`);
      }

      return result.stdout.trim();
    } finally {
      cleanup();
    }
  }

  /**
   * Open an SSH session to `host` that requests one or more local port
   * forwards (`-L localPort:remoteHost:remotePort`) and runs `remoteCommand`
   * on the remote side. Stays in foreground until the user kills it or the
   * remote command exits. Returns the child's exit info.
   */
  async sshForward(opts: {
    host: string;
    username?: string;
    forwards: Array<{
      localPort: number;
      remotePort: number;
      remoteHost?: string;
    }>;
    remoteCommand?: string;
    onReady?: () => void;
    /** Number of `Forwarding from …` lines expected on stderr before declaring readiness. */
    expectedForwardLines?: number;
  }): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
    const username = opts.username ?? 'root';
    const { privateKeyPath, certificatePath, cleanup } =
      await this.generateEphemeralKeypair();

    const args: string[] = [
      '-i',
      privateKeyPath,
      '-o',
      `CertificateFile=${certificatePath}`,
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'PubkeyAuthentication=yes',
      '-o',
      'PreferredAuthentications=publickey',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ExitOnForwardFailure=yes',
    ];

    for (const f of opts.forwards) {
      const remoteHost = f.remoteHost ?? '127.0.0.1';
      args.push('-L', `${f.localPort}:${remoteHost}:${f.remotePort}`);
    }

    if (!opts.remoteCommand) {
      args.push('-N');
    }
    args.push(`${username}@${opts.host}`);
    if (opts.remoteCommand) {
      args.push(opts.remoteCommand);
    }

    return new Promise((resolve) => {
      const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      const onSignal = (signal: NodeJS.Signals) => {
        if (!child.killed) child.kill(signal);
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      // Forward output to terminal AND watch for the kubectl readiness marker
      // ("Forwarding from 127.0.0.1:<port>"). Fire onReady once we have seen
      // as many such lines as kubectl forwards we requested.
      let readyFired = false;
      let forwardingLinesSeen = 0;
      const expected = opts.expectedForwardLines ?? 0;

      const watchStream = (
        stream: NodeJS.ReadableStream,
        sink: NodeJS.WriteStream,
      ) => {
        let buffer = '';
        stream.on('data', (chunk: Buffer) => {
          sink.write(chunk);
          buffer += chunk.toString('utf-8');
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (
              !readyFired &&
              expected > 0 &&
              /Forwarding from 127\.0\.0\.1:\d+/.test(line)
            ) {
              forwardingLinesSeen += 1;
              if (forwardingLinesSeen >= expected) {
                readyFired = true;
                opts.onReady?.();
              }
            }
          }
        });
      };
      if (child.stdout) watchStream(child.stdout, process.stdout);
      if (child.stderr) watchStream(child.stderr, process.stderr);

      // Fallback for the no-kubectl case (e.g. pure kube-api forward): no
      // readiness marker on stderr, declare ready after a short grace period.
      let readyTimer: NodeJS.Timeout | undefined;
      if (opts.onReady && expected === 0) {
        readyTimer = setTimeout(() => {
          if (!readyFired && child.exitCode === null) {
            readyFired = true;
            opts.onReady?.();
          }
        }, 1500);
      }

      child.on('exit', (status, signal) => {
        if (readyTimer) clearTimeout(readyTimer);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        cleanup();
        resolve({ status, signal });
      });
    });
  }

  /**
   * Run a command over the operator's OWN SSH key (not a Flui CA cert) — the
   * only way into a BYOS host before the Flui CA is installed.
   */
  async sshExecWithKey(opts: {
    host: string;
    command: string;
    user?: string;
    keyPath: string;
    port?: number;
    timeoutMs?: number;
  }): Promise<string> {
    const result = spawnSync(
      'ssh',
      [
        '-i',
        opts.keyPath,
        '-p',
        String(opts.port ?? 22),
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'PreferredAuthentications=publickey',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        `${opts.user ?? 'root'}@${opts.host}`,
        opts.command,
      ],
      { encoding: 'utf-8', timeout: opts.timeoutMs ?? 30_000 },
    );

    if (
      result.error &&
      (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    ) {
      throw new Error(`SSH command timed out on ${opts.host}`);
    }
    if (result.status !== 0) {
      const errMsg =
        result.stderr?.trim() || `SSH exited with code ${result.status}`;
      throw new Error(`Command failed on ${opts.host}: ${errMsg}`);
    }
    return result.stdout.trim();
  }

  /**
   * Stream a bootstrap script to a BYOS host over the operator key and run it
   * via `bash -s` (no scp); `sudo` is prefixed for non-root users.
   */
  async runScriptWithKey(opts: {
    host: string;
    script: string;
    user?: string;
    keyPath: string;
    port?: number;
    onData?: (chunk: string) => void;
  }): Promise<void> {
    const user = opts.user ?? 'root';
    const runner = user === 'root' ? 'bash -s' : 'sudo -n bash -s';

    return new Promise((resolve, reject) => {
      const child = spawn(
        'ssh',
        [
          '-i',
          opts.keyPath,
          '-p',
          String(opts.port ?? 22),
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'PreferredAuthentications=publickey',
          '-o',
          'BatchMode=yes',
          '-o',
          'ServerAliveInterval=15',
          '-o',
          'ServerAliveCountMax=8',
          `${user}@${opts.host}`,
          runner,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );

      const sink = (chunk: Buffer): void => {
        const text = chunk.toString('utf-8');
        if (opts.onData) opts.onData(text);
        else process.stdout.write(text);
      };
      child.stdout?.on('data', sink);
      child.stderr?.on('data', sink);
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Bootstrap script exited with code ${code}`));
      });

      // Feed the script over stdin, then close so `bash -s` runs it.
      child.stdin?.write(opts.script);
      child.stdin?.end();
    });
  }

  /**
   * Like sshExec (CA-signed cert auth) but allows a custom port — used to
   * verify, after BYOS bootstrap, that the host now trusts the Flui CA.
   */
  async sshExecCertOnPort(
    host: string,
    command: string,
    port: number,
    username: string = 'root',
  ): Promise<string> {
    const { privateKeyPath, certificatePath, cleanup } =
      await this.generateEphemeralKeypair();
    try {
      const result = spawnSync(
        'ssh',
        [
          '-i',
          privateKeyPath,
          '-p',
          String(port),
          '-o',
          `CertificateFile=${certificatePath}`,
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'PasswordAuthentication=no',
          '-o',
          'PreferredAuthentications=publickey',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=10',
          `${username}@${host}`,
          command,
        ],
        { encoding: 'utf-8', timeout: 30_000 },
      );
      if (result.status !== 0) {
        const errMsg =
          result.stderr?.trim() || `SSH exited with code ${result.status}`;
        throw new Error(`Command failed: ${errMsg}`);
      }
      return result.stdout.trim();
    } finally {
      cleanup();
    }
  }

  /**
   * Get remote log file via SSH
   */
  async getRemoteLog(
    host: string,
    logPath: string,
    username: string = 'root',
    port = 22,
  ): Promise<string> {
    return this.sshExec(host, `cat '${logPath}'`, username, port);
  }

  /**
   * Tail remote log file via SSH
   */
  async tailRemoteLog(
    host: string,
    logPath: string,
    lines: number = 100,
    username: string = 'root',
    port = 22,
  ): Promise<string> {
    return this.sshExec(host, `tail -n ${lines} '${logPath}'`, username, port);
  }

  /**
   * Stream remote log file via SSH with tail -f
   * Returns a cleanup function that should be called to stop streaming and cleanup resources
   */
  async streamRemoteLog(
    host: string,
    logPath: string,
    username: string = 'root',
    port = 22,
    onData?: (data: string) => void,
  ): Promise<{ cleanup: () => void }> {
    const {
      privateKeyPath,
      certificatePath,
      cleanup: cleanupKeys,
    } = await this.generateEphemeralKeypair();

    this.logger.debug(
      `Starting log stream from ${username}@${host}:${port}:${logPath}`,
    );

    // Spawn SSH process with tail -f
    const sshProcess = spawn(
      'ssh',
      [
        '-i',
        privateKeyPath,
        '-p',
        String(port),
        '-o',
        `CertificateFile=${certificatePath}`,
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'PasswordAuthentication=no',
        '-o',
        'PubkeyAuthentication=yes',
        '-o',
        'PreferredAuthentications=publickey',
        '-o',
        'BatchMode=yes',
        `${username}@${host}`,
        `tail -f ${logPath}`,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    // Forward stdout to callback or console
    sshProcess.stdout.on('data', (data) => {
      const text = data.toString();
      if (onData) {
        onData(text);
      } else {
        process.stdout.write(text);
      }
    });

    // Forward stderr to console
    sshProcess.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    // Handle process errors
    sshProcess.on('error', (error) => {
      this.logger.error(`SSH stream process error: ${error.message}`);
    });

    // Cleanup function to kill process and cleanup keys
    const cleanup = () => {
      if (!sshProcess.killed) {
        this.logger.debug('Stopping log stream...');
        sshProcess.kill('SIGTERM');

        // Force kill after 2 seconds if still running
        setTimeout(() => {
          if (!sshProcess.killed) {
            sshProcess.kill('SIGKILL');
          }
        }, 2000);
      }
      cleanupKeys();
    };

    // Cleanup on process exit
    sshProcess.on('exit', (code, signal) => {
      this.logger.debug(
        `SSH stream process exited with code ${code}, signal ${signal}`,
      );
      cleanupKeys();
    });

    return { cleanup };
  }
}
