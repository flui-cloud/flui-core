import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';
import { ProfileManager } from '../../../lib/profile-manager';
import { promptMaskedInput } from '../../../lib/prompts';
import { requireOpenVault } from '../../../lib/vault/require-vault';
import {
  SealedPlatformIdentity,
  defaultRecoveryFilePath,
} from '../../../lib/vault/sealed-platform-identity';
import { WrongPassphraseError } from '../../../lib/vault/vault-file';

// age-encryption is ESM-only ("type": "module"). Under tsc module=commonjs a
// bare `await import()` is down-levelled to require(), which throws on an ESM
// package. The Function shim keeps a genuine dynamic import in the emitted JS
// while `typeof import(...)` still gives us full types.
type AgeModule = typeof import('age-encryption');
const loadAge = new Function(
  'return import("age-encryption")',
) as () => Promise<AgeModule>;

type Outcome = 'created' | 'kept' | 'rotated';

export default class BackupPlatformInit extends Command {
  static readonly description =
    "Create the key that seals the Flui master's platform backups and keep it in your vault, so the vault passphrase is the only secret you carry. Writes a recovery copy sealed with that same passphrase for the day this machine is gone. The secret key never touches the master.";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --out /Volumes/usb/flui-recovery.age',
    '<%= config.bin %> <%= command.id %> --rotate --force',
  ];

  static readonly flags = {
    policy: Flags.string({
      description: 'Platform backup policy ID to attach the recipient to',
    }),
    'heartbeat-url': Flags.string({
      description:
        "Dead-man's-switch URL the master pings while backups are fresh",
    }),
    out: Flags.string({
      description:
        'Where to write the recovery copy (default: ~/flui-<profile>-platform-recovery.age)',
    }),
    passphrase: Flags.string({
      description:
        'Your vault passphrase, which also seals the recovery copy (prompted if omitted)',
    }),
    rotate: Flags.boolean({
      default: false,
      description:
        'Replace the key kept in the vault. Backups taken before stay readable: the old key is kept and goes into the recovery copy too.',
    }),
    force: Flags.boolean({
      default: false,
      description: 'Overwrite an existing recovery copy at --out',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupPlatformInit);
    if (!flags.json) printContextBanner();

    const profile = ProfileManager.getActiveProfile();
    try {
      requireOpenVault(profile);
    } catch (err) {
      this.error((err as Error).message, { exit: 1 });
    }
    const vault = new SealedPlatformIdentity(profile);

    const outPath = path.resolve(flags.out ?? defaultRecoveryFilePath(profile));
    if (fs.existsSync(outPath) && !flags.force) {
      this.error(
        `Refusing to overwrite ${outPath}. Pass --force to overwrite, or --out elsewhere.`,
        { exit: 1 },
      );
    }

    const passphrase = await this.vaultPassphrase(vault, flags);

    const age = await loadAge();
    let outcome: Outcome = 'kept';
    if (!vault.exists() || flags.rotate) {
      outcome = vault.exists() ? 'rotated' : 'created';
      const identity = await age.generateIdentity();
      vault.store(identity, await age.identityToRecipient(identity));
    }
    const recipient = vault.recipient() as string;
    const identities = vault.identities();

    const encrypter = new age.Encrypter();
    encrypter.setPassphrase(passphrase);
    const sealed = await encrypter.encrypt(
      new TextEncoder().encode(`${identities.join('\n')}\n`),
    );
    fs.writeFileSync(outPath, age.armor.encode(sealed), { mode: 0o600 });
    try {
      fs.chmodSync(outPath, 0o600);
    } catch {
      /* best-effort — Windows/odd FS */
    }

    if (flags.policy) await this.register(flags, recipient, outPath);

    if (flags.json) {
      this.log(
        JSON.stringify(
          { recipient, out: outPath, outcome, keys: identities.length },
          null,
          2,
        ),
      );
      return;
    }
    this.report(outcome, recipient, outPath, identities.length, flags.policy);
  }

  private async vaultPassphrase(
    vault: SealedPlatformIdentity,
    flags: { passphrase?: string; json: boolean },
  ): Promise<string> {
    let passphrase = flags.passphrase;
    if (!passphrase) {
      if (flags.json) {
        this.error('Pass --passphrase when using --json (cannot prompt).', {
          exit: 1,
        });
      }
      passphrase = await promptMaskedInput(
        '   Vault passphrase (it also seals the recovery copy)',
      );
    }
    try {
      vault.verifyVaultPassphrase(passphrase);
    } catch (err) {
      if (err instanceof WrongPassphraseError) {
        this.error(
          'That is not your vault passphrase. The recovery copy is sealed with the vault passphrase, so there is only one to remember.',
          { exit: 1 },
        );
      }
      throw err;
    }
    return passphrase;
  }

  private async register(
    flags: { policy?: string; 'heartbeat-url'?: string },
    recipient: string,
    outPath: string,
  ): Promise<void> {
    const spinner = ora('Registering recipient on platform policy...').start();
    try {
      await BackupClient.fromConfig().setPlatformConfig(
        flags.policy as string,
        {
          recipient,
          ...(flags['heartbeat-url']
            ? { heartbeatUrl: flags['heartbeat-url'] }
            : {}),
        },
      );
      spinner.succeed(`Recipient registered on policy ${flags.policy}`);
    } catch (err) {
      spinner.fail(`Failed to register recipient: ${(err as Error).message}`);
      this.printReminder(outPath);
      this.exit(1);
    }
  }

  private report(
    outcome: Outcome,
    recipient: string,
    outPath: string,
    keys: number,
    policy?: string,
  ): void {
    const what: Record<Outcome, string> = {
      created: 'New platform backup key created and kept in your vault',
      kept: 'Platform backup key already in your vault — kept as it is',
      rotated:
        'Platform backup key replaced; the previous one stays in the vault for older backups',
    };
    this.log('');
    this.log(`   ${chalk.green('✔')} ${what[outcome]}`);
    this.log(
      `   ${chalk.green('✔')} Recovery copy written to ${chalk.bold(outPath)} ${chalk.dim(`(${keys} key${keys === 1 ? '' : 's'}, sealed with your vault passphrase)`)}`,
    );
    this.log('');
    this.log(
      `   ${chalk.bold('Operator recipient')} ${chalk.dim('(public — this is what backups are sealed to)')}`,
    );
    this.log(`   ${chalk.cyan(recipient)}`);
    this.log('');
    if (outcome === 'rotated') {
      this.log(
        chalk.yellow(
          '   Policies still seal to the previous key until you register the new one:\n' +
            '     flui backup platform init --policy <policy-id> --force',
        ),
      );
      this.log('');
    } else if (!policy) {
      this.log(`   ${chalk.bold('Next step —')} turn the backup on:`);
      this.log(
        `     ${chalk.cyan('flui backup enable platform -D <destination-id>')}`,
      );
      this.log(
        `   ${chalk.dim('The recipient is taken from your vault; see destinations with `flui backup destination list`.')}`,
      );
    }
    this.printReminder(outPath);
  }

  private printReminder(outPath: string): void {
    this.log('');
    this.log(chalk.yellow('   ' + '─'.repeat(68)));
    this.log(
      chalk.yellow.bold('   ⚠  MOVE THE RECOVERY COPY OFF THIS MACHINE'),
    );
    this.log(
      chalk.yellow(
        `      ${chalk.bold(outPath)} opens with your vault passphrase.`,
      ),
    );
    this.log(
      chalk.yellow(
        '      The vault lives here; the copy is what a rebuild starts from if',
      ),
    );
    this.log(
      chalk.yellow(
        '      this machine is lost. Keep it off the master and out of any repo.',
      ),
    );
    this.log(chalk.yellow('   ' + '─'.repeat(68)));
    this.log('');
  }
}
