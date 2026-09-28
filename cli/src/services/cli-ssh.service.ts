import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { CliCaService } from './cli-ca.service';
import { SealedSshKey } from '../lib/vault/sealed-ssh-key';

interface Ssh2ExecStream {
  on(event: string, cb: (...args: unknown[]) => void): Ssh2ExecStream;
  stderr: { on(event: string, cb: (...args: unknown[]) => void): void };
}
interface Ssh2Client {
  on(event: string, cb: (...args: unknown[]) => void): Ssh2Client;
  exec(
    cmd: string,
    cb: (err: Error | undefined, stream: Ssh2ExecStream) => void,
  ): void;
  connect(cfg: Record<string, unknown>): void;
  end(): void;
}

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
  private readonly managedKey = new SealedSshKey();

  constructor(private readonly caService: CliCaService) {}

  /**
   * Flui's own SSH key: the public half for provisioning, and the path that
   * names it. The private half is sealed in the vault; a key left in plaintext
   * by an older CLI is used until `flui vault unlock` seals it.
   */
  async getOrCreateSshKey(): Promise<{
    publicKey: string;
    privateKeyPath: string;
    publicKeyPath: string;
  }> {
    if (!this.managedKey.exists()) {
      this.logger.log(
        'Generating a new SSH key for Flui, sealed in the vault...',
      );
      this.managedKey.create();
    }
    return {
      publicKey: this.managedKey.publicKey(),
      privateKeyPath: this.managedKey.reference,
      publicKeyPath: this.managedKey.publicKeyPath,
    };
  }

  /**
   * Runs `use` with a file holding the key `keyPath` names. Flui's own key is
   * sealed, so it gets a private copy for the length of the call; any other
   * path is the operator's and is used as it is.
   */
  private async withKeyFile<T>(
    keyPath: string,
    use: (file: string) => Promise<T> | T,
  ): Promise<T> {
    if (this.managedKey.isManaged(keyPath) && !fs.existsSync(keyPath)) {
      return this.managedKey.withPrivateKeyFile(use);
    }
    return use(keyPath);
  }

  private keyAvailable(keyPath: string): boolean {
    return (
      fs.existsSync(keyPath) ||
      (this.managedKey.isManaged(keyPath) && this.managedKey.exists())
    );
  }

  /**
   * Get SSH public key content
   */
  async getPublicKey(): Promise<string> {
    const { publicKey } = await this.getOrCreateSshKey();
    return publicKey;
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
    // `flui-jump` lets the same certificate cross the control on the way to a
    // workload node; the control accepts it for that user and nothing else.
    const certificate = await this.caService.signPublicKey(publicKey, 300, [
      'root',
      'ubuntu',
      'admin',
      'flui-jump',
    ]);

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
    jump?: { host: string; user: string; port: number },
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
          ...(jump
            ? ['-o', proxyThrough(jump, privateKeyPath, certificatePath)]
            : []),
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
    jump?: { host: string; user: string; port: number },
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
          ...(jump
            ? ['-o', proxyThrough(jump, privateKeyPath, certificatePath)]
            : []),
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
    port?: number;
    forwards: Array<{
      localPort: number;
      remotePort: number;
      remoteHost?: string;
    }>;
    remoteCommand?: string;
    onReady?: () => void;
    /** Number of `Forwarding from …` lines expected on stderr before declaring readiness. */
    expectedForwardLines?: number;
    /** Reach the host through the control, on its Flui network address. */
    jump?: { host: string; user: string; port: number };
  }): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
    const username = opts.username ?? 'root';
    const { privateKeyPath, certificatePath, cleanup } =
      await this.generateEphemeralKeypair();

    const args: string[] = [
      '-i',
      privateKeyPath,
      '-p',
      String(opts.port ?? 22),
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
      ...(opts.jump
        ? ['-o', proxyThrough(opts.jump, privateKeyPath, certificatePath)]
        : []),
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
    return this.withKeyFile(opts.keyPath, (keyFile) =>
      this.sshExecWithKeyFile({ ...opts, keyPath: keyFile }),
    );
  }

  private sshExecWithKeyFile(opts: {
    host: string;
    command: string;
    user?: string;
    keyPath: string;
    port?: number;
    timeoutMs?: number;
  }): string {
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

  async canAuthWithKey(opts: {
    host: string;
    port?: number;
    user?: string;
    keyPath: string;
  }): Promise<boolean> {
    try {
      const out = await this.sshExecWithKey({
        host: opts.host,
        port: opts.port,
        user: opts.user,
        keyPath: opts.keyPath,
        command: 'echo flui-key-ok',
        timeoutMs: 15_000,
      });
      return out.includes('flui-key-ok');
    } catch {
      return false;
    }
  }

  publicKeyFor(keyPath: string): string | null {
    if (this.managedKey.isManaged(keyPath) && this.managedKey.exists()) {
      return this.managedKey.publicKey();
    }
    const pub = `${keyPath}.pub`;
    if (fs.existsSync(pub)) {
      const content = fs.readFileSync(pub, 'utf-8').trim();
      if (content) return content;
    }
    const derived = spawnSync('ssh-keygen', ['-y', '-f', keyPath, '-P', ''], {
      encoding: 'utf-8',
    });
    if (derived.status === 0 && derived.stdout.trim()) {
      return derived.stdout.trim();
    }
    return null;
  }

  isKeyEncrypted(keyPath: string): boolean {
    if (!fs.existsSync(keyPath)) return false;
    const r = spawnSync('ssh-keygen', ['-y', '-f', keyPath, '-P', ''], {
      encoding: 'utf-8',
    });
    return r.status !== 0;
  }

  private pickInstallKey(
    explicitKeyPath: string | undefined,
    managedKeyPath: string,
    log: (msg: string) => void,
  ): string {
    if (!explicitKeyPath || !fs.existsSync(explicitKeyPath)) {
      return managedKeyPath;
    }
    if (!this.isKeyEncrypted(explicitKeyPath)) return explicitKeyPath;
    log(
      `⚠ ${explicitKeyPath} is passphrase-protected and not in your ssh-agent — can't use it non-interactively.`,
    );
    log(
      `  Using Flui's managed key instead. Tip: \`ssh-add ${explicitKeyPath}\` then retry to use your own key.`,
    );
    return managedKeyPath;
  }

  async installPublicKeyWithPassword(opts: {
    host: string;
    port?: number;
    user?: string;
    publicKey: string;
  }): Promise<void> {
    if (!process.stdin.isTTY) {
      throw new Error(
        'A key needs authorizing on the host but there is no terminal for the password prompt. ' +
          'Run interactively, pass --ssh-key with a key the host already trusts, or pre-authorize one with `ssh-copy-id`.',
      );
    }
    const user = opts.user ?? 'root';
    const remote =
      'umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; ' +
      `grep -qxF '${opts.publicKey}' ~/.ssh/authorized_keys || echo '${opts.publicKey}' >> ~/.ssh/authorized_keys`;
    const result = spawnSync(
      'ssh',
      [
        '-p',
        String(opts.port ?? 22),
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'PubkeyAuthentication=no',
        '-o',
        'PreferredAuthentications=password,keyboard-interactive',
        '-o',
        'NumberOfPasswordPrompts=3',
        '-o',
        'ConnectTimeout=15',
        `${user}@${opts.host}`,
        remote,
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      throw new Error(
        `Could not authorize the SSH key on ${user}@${opts.host} (ssh exit ${result.status ?? result.signal}). ` +
          'Check the password and that the host allows password login.',
      );
    }
  }

  async installPublicKeyWithPasswordValue(opts: {
    host: string;
    port?: number;
    user?: string;
    password: string;
    publicKey: string;
  }): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('ssh2') as { Client: new () => Ssh2Client };

    const user = opts.user ?? 'root';
    const remote =
      'umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; ' +
      `grep -qxF '${opts.publicKey}' ~/.ssh/authorized_keys || echo '${opts.publicKey}' >> ~/.ssh/authorized_keys`;

    await new Promise<void>((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        try {
          conn.end();
        } catch {
          /* already closed */
        }
        if (err) reject(err);
        else resolve();
      };

      conn.on('ready', () => this.execForKeyInstall(conn, remote, done));
      conn.on('error', (...args: unknown[]) =>
        done(
          new Error(
            `SSH password auth failed for ${user}@${opts.host}: ${(args[0] as Error).message}`,
          ),
        ),
      );
      conn.on('keyboard-interactive', (...args: unknown[]) =>
        (args[4] as (responses: string[]) => void)([opts.password]),
      );

      conn.connect({
        host: opts.host,
        port: opts.port ?? 22,
        username: user,
        password: opts.password,
        readyTimeout: 20_000,
        tryKeyboard: true,
      });
    });
  }

  private execForKeyInstall(
    conn: Ssh2Client,
    cmd: string,
    done: (err?: Error) => void,
  ): void {
    conn.exec(cmd, (err, stream) => {
      if (err) return done(err);
      let stderr = '';
      stream.on('close', (...args: unknown[]) => {
        const code = (args[0] as number) ?? 0;
        const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
        done(
          code === 0
            ? undefined
            : new Error(`key install exited ${code}${suffix}`),
        );
      });
      stream.on('data', () => {});
      stream.stderr.on('data', (...args: unknown[]) => {
        stderr += (args[0] as Buffer).toString();
      });
    });
  }

  private async authorizeKeyOnHost(opts: {
    host: string;
    port: number;
    user: string;
    publicKey: string;
    password?: string;
    log: (msg: string) => void;
  }): Promise<void> {
    if (opts.password) {
      opts.log('Authorizing one with the supplied password (non-interactive).');
      await this.installPublicKeyWithPasswordValue({
        host: opts.host,
        port: opts.port,
        user: opts.user,
        password: opts.password,
        publicKey: opts.publicKey,
      });
      return;
    }
    opts.log(
      'Authorizing one now — enter the host password once when prompted',
    );
    opts.log('(used only to install the key, never stored).');
    await this.installPublicKeyWithPassword({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      publicKey: opts.publicKey,
    });
  }

  async ensureKeyAccess(opts: {
    host: string;
    port?: number;
    user?: string;
    explicitKeyPath?: string;
    password?: string;
    log?: (msg: string) => void;
  }): Promise<{ keyPath: string; installed: boolean }> {
    const user = opts.user ?? 'root';
    const port = opts.port ?? 22;
    const log = opts.log ?? ((): void => {});

    const candidates: string[] = [];
    if (opts.explicitKeyPath) candidates.push(opts.explicitKeyPath);
    for (const name of ['id_ed25519', 'id_rsa']) {
      const p = path.join(os.homedir(), '.ssh', name);
      if (fs.existsSync(p) && !candidates.includes(p)) candidates.push(p);
    }
    const managed = await this.getOrCreateSshKey();
    if (!candidates.includes(managed.privateKeyPath)) {
      candidates.push(managed.privateKeyPath);
    }

    for (const keyPath of candidates) {
      if (!this.keyAvailable(keyPath)) continue;
      if (await this.canAuthWithKey({ host: opts.host, port, user, keyPath })) {
        log(`SSH key already authorized (${keyPath})`);
        return { keyPath, installed: false };
      }
    }

    const installKeyPath = this.pickInstallKey(
      opts.explicitKeyPath,
      managed.privateKeyPath,
      log,
    );
    const publicKey = this.publicKeyFor(installKeyPath);
    if (!publicKey) {
      throw new Error(
        `Could not read or derive the public key for ${installKeyPath}.`,
      );
    }
    log(`No SSH key is authorized on ${user}@${opts.host} yet.`);
    await this.authorizeKeyOnHost({
      host: opts.host,
      port,
      user,
      publicKey,
      password: opts.password,
      log,
    });
    if (
      !(await this.canAuthWithKey({
        host: opts.host,
        port,
        user,
        keyPath: installKeyPath,
      }))
    ) {
      throw new Error(
        `Authorized a key on ${user}@${opts.host} but it still does not authenticate. ` +
          'Check sshd PubkeyAuthentication and ~/.ssh permissions on the host.',
      );
    }
    log(`✅ SSH key authorized (${installKeyPath})`);
    return { keyPath: installKeyPath, installed: true };
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
    return this.withKeyFile(opts.keyPath, (keyFile) =>
      this.streamScript({
        host: opts.host,
        script: opts.script,
        user: opts.user,
        port: opts.port,
        onData: opts.onData,
        authArgs: ['-i', keyFile],
      }),
    );
  }

  /**
   * Like runScriptWithKey but uses an ephemeral CA-signed cert instead of a
   * stored key — works on any host that already trusts the Flui CA, no local
   * key file needed. Cert validity is only checked at handshake, so it's safe
   * for multi-minute scripts even with a short-lived cert.
   */
  async runScriptWithCert(opts: {
    host: string;
    script: string;
    user?: string;
    port?: number;
    onData?: (chunk: string) => void;
  }): Promise<void> {
    const { privateKeyPath, certificatePath, cleanup } =
      await this.generateEphemeralKeypair();
    try {
      await this.streamScript({
        host: opts.host,
        script: opts.script,
        user: opts.user,
        port: opts.port,
        onData: opts.onData,
        authArgs: [
          '-i',
          privateKeyPath,
          '-o',
          `CertificateFile=${certificatePath}`,
          '-o',
          'PasswordAuthentication=no',
          '-o',
          'PubkeyAuthentication=yes',
        ],
      });
    } finally {
      cleanup();
    }
  }

  /** Shared streaming implementation behind runScriptWithKey/runScriptWithCert. */
  private streamScript(opts: {
    host: string;
    script: string;
    user?: string;
    port?: number;
    onData?: (chunk: string) => void;
    authArgs: string[];
  }): Promise<void> {
    const user = opts.user ?? 'root';
    const runner = user === 'root' ? 'bash -s' : 'sudo -n bash -s';

    return new Promise((resolve, reject) => {
      const child = spawn(
        'ssh',
        [
          ...opts.authArgs,
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
        else reject(new Error(`Script exited with code ${code}`));
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
    command?: string,
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
        command ?? `tail -f ${logPath}`,
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

/**
 * The control forwards to the node and does nothing else, with the same
 * certificate, so a workload's port 22 never has to face the internet.
 */
export function proxyThrough(
  jump: { host: string; user: string; port: number },
  privateKeyPath: string,
  certificatePath: string,
): string {
  return [
    'ProxyCommand=ssh',
    `-i ${privateKeyPath}`,
    `-o CertificateFile=${certificatePath}`,
    '-o StrictHostKeyChecking=no',
    '-o UserKnownHostsFile=/dev/null',
    '-o PasswordAuthentication=no',
    `-p ${jump.port}`,
    '-W %h:%p',
    `${jump.user}@${jump.host}`,
  ].join(' ');
}
