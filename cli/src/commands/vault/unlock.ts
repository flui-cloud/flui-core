import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { ProfileManager } from '../../lib/profile-manager';
import { ConfigStorage } from '../../lib/config-storage';
import { VaultFile, WrongPassphraseError } from '../../lib/vault/vault-file';
import { deriveProfileKey } from '../../lib/vault/vault-crypto';
import { askAgent, socketPath } from '../../lib/vault/vault-agent';
import {
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
      return;
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

  private async askForPassphrase(): Promise<string> {
    refuseToAsk(
      'the vault passphrase',
      'Pass it on standard input instead:  printf "…" | flui vault unlock --stdin',
    );
    return (await promptMaskedInput('  Vault passphrase')).trim();
  }
}
