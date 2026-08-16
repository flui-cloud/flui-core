import { createServer, connect, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { ProfileManager } from '../profile-manager';
import {
  deriveProfileKey,
  wipe,
  type MasterKey,
  type ProfileKey,
} from './vault-crypto';
import {
  isClosed,
  resolveLimits,
  sessionState,
  type SessionLimits,
  type SessionState,
} from './vault-session';

export interface AgentRequest {
  op: 'profile-key' | 'status' | 'lock';
  profile?: string;
}

export interface AgentResponse {
  ok: boolean;
  /** base64 profile key, only for `profile-key`. */
  key?: string;
  state?: SessionState;
  error?: string;
}

/**
 * A unix socket path cannot exceed 104 bytes on macOS or 108 on Linux, and the
 * kernel does not say so — it reports `EADDRINUSE`, which sends whoever is
 * debugging it looking for a stale agent that was never there. A home directory
 * nested a few levels deep is enough to cross it.
 *
 * So the socket lives in the temporary directory under a short name derived
 * from the home it belongs to, rather than inside that home. Two homes get two
 * agents; the same home always gets the same path.
 */
const SOCKET_PATH_LIMIT = 100;

export function socketDir(baseDir: string = ProfileManager.BASE_DIR): string {
  const tag = createHash('sha256').update(baseDir).digest('hex').slice(0, 8);
  return join(tmpdir(), `flui-vault-${userInfo().uid}-${tag}`);
}

export function socketPath(baseDir: string = ProfileManager.BASE_DIR): string {
  const path = join(socketDir(baseDir), 'agent.sock');
  if (Buffer.byteLength(path) > SOCKET_PATH_LIMIT) {
    throw new Error(
      `The vault agent socket path is too long for this system (${Buffer.byteLength(path)} bytes): ${path}\n` +
        'Set TMPDIR to a shorter directory and unlock again.',
    );
  }
  return path;
}

/**
 * Holds the unlocked key so the operator is asked once rather than constantly.
 *
 * Access is controlled by the filesystem, the same way `ssh-agent` does it: the
 * socket is mode 0600 inside a directory only its owner can traverse, so no
 * other user on the machine can reach it. That is the boundary this defends —
 * another *user*. It does not defend against something already running as you,
 * which could read this process's memory directly; a vault protects a stolen
 * laptop and a copied home directory, not a machine that is already someone
 * else's.
 *
 * What it hands back is a key derived for one profile, never the master key. A
 * command working in one profile therefore cannot open another's credentials,
 * even though both are sealed under the same passphrase.
 */
export class VaultAgent {
  private server: Server | null = null;
  private master: MasterKey | null = null;
  private openedAt = 0;
  private lastUsedAt = 0;
  private sweep: NodeJS.Timeout | null = null;

  constructor(
    private readonly baseDir: string = ProfileManager.BASE_DIR,
    private readonly limits: SessionLimits = resolveLimits(),
    private readonly onClosed: (reason: string) => void = () => process.exit(0),
  ) {}

  async listen(master: MasterKey): Promise<string> {
    const dir = socketDir(this.baseDir);
    const path = socketPath(this.baseDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A leftover socket from a killed agent would make `listen` fail; it holds
    // no key, so removing it costs nothing.
    rmSync(path, { force: true });

    this.master = master;
    this.openedAt = Date.now();
    this.lastUsedAt = this.openedAt;

    await new Promise<void>((resolve, reject) => {
      this.server = createServer((socket) => this.serve(socket));
      this.server.once('error', reject);
      this.server.listen(path, () => resolve());
    });

    chmodSync(path, 0o600);
    // The directory is what actually keeps other users out; the socket mode is
    // belt and braces, since some systems ignore permissions on sockets.
    chmodSync(dir, 0o700);

    this.sweep = setInterval(() => this.checkExpiry(), 30_000);
    this.sweep.unref();
    return path;
  }

  private serve(socket: Socket): void {
    socket.setEncoding('utf-8');
    let buffer = '';

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        socket.write(`${JSON.stringify(this.handle(line))}\n`);
      }
    });
    socket.on('error', () => socket.destroy());
  }

  private handle(line: string): AgentResponse {
    let request: AgentRequest;
    try {
      request = JSON.parse(line);
    } catch {
      return { ok: false, error: 'Malformed request.' };
    }

    if (request.op === 'lock') {
      this.close('locked on request');
      return { ok: true };
    }

    const state = this.checkExpiry();
    if (isClosed(state)) {
      return {
        ok: false,
        state,
        error: `The vault is locked (${state.reason}).`,
      };
    }

    if (request.op === 'status') {
      return { ok: true, state };
    }

    if (request.op === 'profile-key') {
      if (!request.profile || !this.master) {
        return { ok: false, error: 'A profile name is required.' };
      }
      // Only now does the idle clock move. A status check is not use: polling
      // it must not be able to hold the vault open indefinitely.
      this.lastUsedAt = Date.now();
      const key: ProfileKey = deriveProfileKey(this.master, request.profile);
      const encoded = key.toString('base64');
      wipe(key);
      return { ok: true, key: encoded, state };
    }

    return { ok: false, error: `Unknown operation: ${String(request.op)}` };
  }

  private checkExpiry(): SessionState {
    const state = sessionState(
      Date.now(),
      this.openedAt,
      this.lastUsedAt,
      this.limits,
    );
    if (isClosed(state)) this.close(state.reason);
    return state;
  }

  close(reason: string): void {
    if (this.master) {
      wipe(this.master);
      this.master = null;
    }
    if (this.sweep) clearInterval(this.sweep);
    this.server?.close();
    rmSync(socketPath(this.baseDir), { force: true });
    this.onClosed(reason);
  }
}

/**
 * Asks a running agent for a key. Returns null when there is no agent, which
 * the caller reads as "ask the operator for their passphrase" rather than as an
 * error — a locked vault is a normal state, not a fault.
 */
export async function askAgent(
  request: AgentRequest,
  baseDir: string = ProfileManager.BASE_DIR,
  timeoutMs = 5_000,
): Promise<AgentResponse | null> {
  const path = socketPath(baseDir);
  if (!existsSync(path)) return null;

  return new Promise((resolve) => {
    const socket = connect(path);
    let buffer = '';
    const finish = (value: AgentResponse | null): void => {
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();

    socket.setEncoding('utf-8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const line = buffer.split('\n')[0];
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      try {
        finish(JSON.parse(line));
      } catch {
        finish(null);
      }
    });
    // A socket left behind by a dead agent refuses the connection; that is the
    // same situation as no agent at all.
    socket.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

/** True when the socket exists and is owned by this user with no wider access. */
export function socketIsSafe(
  baseDir: string = ProfileManager.BASE_DIR,
): boolean {
  try {
    const path = socketPath(baseDir);
    if (!existsSync(path)) return false;
    const dir = statSync(socketDir(baseDir));
    // Owned by this user and closed to everyone else. The directory is the
    // control; a socket in a world-traversable directory is reachable however
    // its own mode reads.
    return dir.uid === userInfo().uid && (dir.mode & 0o077) === 0;
  } catch {
    return false;
  }
}
