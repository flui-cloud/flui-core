import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { ProfileManager } from '../../lib/profile-manager';
import { ConfigStorage } from '../../lib/config-storage';
import { VaultFile, WrongPassphraseError } from '../../lib/vault/vault-file';
import { deriveProfileKey } from '../../lib/vault/vault-crypto';
import { askAgent, socketPath } from '../../lib/vault/vault-agent';
import {
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_MS,
  describeRemaining,
  isOpen,
  resolveLimits,
} from '../../lib/vault/vault-session';
import { promptMaskedInput } from '../../lib/prompts';
import { refuseToAsk } from '../../lib/non-interactive';
import { stdinRequested, stdinValue } from '../../lib/stdin-value';

/**
 * Opens the vault for this session.
 *
 * The passphrase is asked once and then held by a small background process
 * until it goes idle or reaches its lifetime, so ordinary work is not
 * interrupted. Nothing is written to disk: the process holds the key, and when
 * it exits the key is gone.
 */
export default class VaultUnlock extends Command {
  static readonly description =
    'Unlock the vault for this session so commands can open stored credentials.';

  static readonly flags = {
    stdin: Flags.boolean({
      description:
        'Read the passphrase from standard input rather than prompting.',
      default: false,
    }),
    'idle-minutes': Flags.integer({
      description:
        `How long the vault may sit unused before it locks itself again ` +
        `(default ${DEFAULT_IDLE_MS / 60_000}). Same effect as setting ` +
        `FLUI_VAULT_IDLE_MINUTES, offered here because that variable has no ` +
        `way to announce itself.`,
      min: 1,
    }),
    'max-minutes': Flags.integer({
      description:
        `Absolute lifetime of the unlock, regardless of activity (default ` +
        `${DEFAULT_MAX_MS / 60_000}) — the backstop against a long-running ` +
        `session holding the key open all day just by staying busy. Same ` +
        `effect as FLUI_VAULT_MAX_MINUTES.`,
      min: 1,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(VaultUnlock);
    const vault = new VaultFile();

    const already = await askAgent({ op: 'status' });
    if (already?.ok && isOpen(already.state)) {
      this.log(
        chalk.green(
          `\n✅ Already unlocked — ${describeRemaining(already.state.idleRemainingMs)} of idle time left.\n`,
        ),
      );
      if (flags['idle-minutes'] || flags['max-minutes']) {
        this.warnLimitsIgnored(flags['idle-minutes'], flags['max-minutes']);
      }
      return;
    }

    if (flags['idle-minutes']) {
      process.env['FLUI_VAULT_IDLE_MINUTES'] = String(flags['idle-minutes']);
    }
    if (flags['max-minutes']) {
      process.env['FLUI_VAULT_MAX_MINUTES'] = String(flags['max-minutes']);
    }

    const passphrase =
      flags.stdin || stdinRequested()
        ? stdinValue()
        : await this.askForPassphrase();

    let master: ReturnType<VaultFile['unlock']>;
    try {
      master = vault.unlock(passphrase);
    } catch (error) {
      if (error instanceof WrongPassphraseError) {
        this.error(error.message, { exit: 1 });
      }
      throw error;
    }

    const migrated = this.migrateProfiles(master);
    await this.startAgent(passphrase);

    const limits = resolveLimits();
    this.log(chalk.green('\n🔓 Vault unlocked\n'));
    this.log(
      chalk.dim(
        `   Closes after ${describeRemaining(limits.idleMs)} of inactivity, ` +
          `and after ${describeRemaining(limits.maxMs)} regardless.\n`,
      ),
    );
    if (migrated > 0) {
      this.log(
        chalk.cyan(
          `   Moved ${migrated} stored secret(s) into the vault and removed the old key files.\n`,
        ),
      );
    }
    this.log(chalk.dim(`   Lock it early with:  flui vault lock\n`));
  }

  /**
   * Moves every profile off the key-file arrangement.
   *
   * Done here rather than lazily, because a profile left behind keeps its key
   * next to its data — the exact weakness the vault exists to remove. Doing it
   * at unlock is the one moment the passphrase is known and every profile can
   * be reached.
   */
  private migrateProfiles(master: ReturnType<VaultFile['unlock']>): number {
    let moved = 0;
    for (const profile of ProfileManager.listProfiles()) {
      const storage = new ConfigStorage(profile);
      if (!storage.hasLegacyKeyFile()) continue;
      try {
        moved += storage.adoptVaultKey(deriveProfileKey(master, profile));
      } catch (error) {
        this.log(
          chalk.yellow(
            `   ⚠ Profile "${profile}" was left as it is: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    }
    return moved;
  }

  /**
   * Starts the agent detached, handing it the passphrase down a pipe.
   *
   * Not as an argument, and not as an environment variable: both are readable
   * by other processes on the machine, and a passphrase that leaks that way
   * undoes the whole exercise.
   */
  private async startAgent(passphrase: string): Promise<void> {
    const child = spawn(
      process.argv[0],
      [process.argv[1], 'vault', 'agent', '--stdin'],
      {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    child.stdin?.end(passphrase);
    child.unref();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const status = await askAgent({ op: 'status' });
      if (status?.ok) return;
    }

    this.error(
      `The vault agent did not start. Expected its socket at ${socketPath()}.`,
      { exit: 1 },
    );
  }

  /** The limits only take hold when a session actually starts, so passing
   * them at an already-open vault is a no-op worth explaining rather than
   * a silent miss. */
  private warnLimitsIgnored(idleMinutes?: number, maxMinutes?: number): void {
    const reunlock = ['flui vault lock && flui vault unlock'];
    if (idleMinutes) reunlock.push(`--idle-minutes ${idleMinutes}`);
    if (maxMinutes) reunlock.push(`--max-minutes ${maxMinutes}`);
    this.log(
      chalk.yellow(
        '   The limits you passed only take effect for a NEW unlock — this ' +
          'one is already running with whatever it started with.\n' +
          `   Apply them with:  ${reunlock.join(' ')}\n`,
      ),
    );
  }

  private async askForPassphrase(): Promise<string> {
    refuseToAsk(
      'the vault passphrase',
      'Pass it on standard input instead:  printf "…" | flui vault unlock --stdin',
    );
    return (await promptMaskedInput('  Vault passphrase')).trim();
  }
}
