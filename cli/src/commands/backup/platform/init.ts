import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';
import { promptMaskedInput } from '../../../lib/prompts';

// age-encryption is ESM-only ("type": "module"). Under tsc module=commonjs a
// bare `await import()` is down-levelled to require(), which throws on an ESM
// package. The Function shim keeps a genuine dynamic import in the emitted JS
// while `typeof import(...)` still gives us full types.
type AgeModule = typeof import('age-encryption');
const loadAge = new Function(
  'return import("age-encryption")',
) as () => Promise<AgeModule>;

export default class BackupPlatformInit extends Command {
  static readonly description =
    "Generate the operator age identity that seals the Flui master's platform backups. Runs entirely on your laptop — the secret key never touches the master.";

  static readonly flags = {
    policy: Flags.string({
      description: 'Platform backup policy ID to attach the recipient to',
    }),
    'heartbeat-url': Flags.string({
      description:
        "Dead-man's-switch URL the master pings while backups are fresh",
    }),
    out: Flags.string({
      default: './flui-master-recovery.age',
      description: 'Path to write the passphrase-protected recovery file',
    }),
    passphrase: Flags.string({
      description:
        'Passphrase to protect the recovery file (prompted if omitted)',
    }),
    force: Flags.boolean({
      default: false,
      description: 'Overwrite an existing recovery file at --out',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupPlatformInit);
    if (!flags.json) printContextBanner();

    const outPath = path.resolve(flags.out);
    if (fs.existsSync(outPath) && !flags.force) {
      this.error(
        `Refusing to overwrite ${outPath}. Pass --force to overwrite.`,
        { exit: 1 },
      );
    }

    const passphrase = await this.resolvePassphrase(
      flags.passphrase,
      flags.json,
    );

    const age = await loadAge();
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);

    const encrypter = new age.Encrypter();
    encrypter.setPassphrase(passphrase);
    const sealed = await encrypter.encrypt(new TextEncoder().encode(identity));
    const armored = age.armor.encode(sealed);

    fs.writeFileSync(outPath, armored, { mode: 0o600 });
    try {
      fs.chmodSync(outPath, 0o600);
    } catch {
      /* best-effort — Windows/odd FS */
    }

    if (flags.json) {
      this.log(JSON.stringify({ recipient, out: outPath }, null, 2));
      return;
    }

    this.log('');
    this.log(
      `   ${chalk.green('✔')} Recovery identity written to ${chalk.bold(outPath)} (mode 0600)`,
    );
    this.log('');
    this.log(
      `   ${chalk.bold('Operator recipient')} ${chalk.dim('(public — this is what you register)')}`,
    );
    this.log(`   ${chalk.cyan(recipient)}`);
    this.log('');

    if (flags.policy) {
      const spinner = ora(
        'Registering recipient on platform policy...',
      ).start();
      try {
        await BackupClient.fromConfig().setPlatformConfig(flags.policy, {
          recipient,
          ...(flags['heartbeat-url']
            ? { heartbeatUrl: flags['heartbeat-url'] }
            : {}),
        });
        spinner.succeed(`Recipient registered on policy ${flags.policy}`);
        if (flags['heartbeat-url']) {
          this.log(
            `   ${chalk.dim('Heartbeat URL:')} ${flags['heartbeat-url']}`,
          );
        }
      } catch (err) {
        spinner.fail(`Failed to register recipient: ${(err as Error).message}`);
        this.printReminder(outPath);
        this.exit(1);
      }
    } else {
      this.log(
        `   ${chalk.bold('Next step —')} attach this recipient to a platform backup policy:`,
      );
      this.log(
        `     ${chalk.cyan('flui backup platform init --policy <policy-id> --force')}`,
      );
      this.log(
        `   ${chalk.dim('or paste the recipient above into the policy platform config.')}`,
      );
    }

    this.printReminder(outPath);
  }

  private async resolvePassphrase(
    provided: string | undefined,
    json: boolean,
  ): Promise<string> {
    if (provided) return provided;
    if (json) {
      this.error('Pass --passphrase when using --json (cannot prompt).', {
        exit: 1,
      });
    }
    const passphrase = await promptMaskedInput(
      '   Passphrase to protect the recovery file',
    );
    if (!passphrase) {
      this.error('A passphrase is required.', { exit: 1 });
    }
    const confirm = await promptMaskedInput('   Confirm passphrase');
    if (confirm !== passphrase) {
      this.error('Passphrases did not match.', { exit: 1 });
    }
    return passphrase;
  }

  private printReminder(outPath: string): void {
    this.log('');
    this.log(chalk.yellow('   ' + '─'.repeat(68)));
    this.log(
      chalk.yellow.bold(
        '   ⚠  STORE THIS RECOVERY FILE AND ITS PASSPHRASE OFFLINE',
      ),
    );
    this.log(
      chalk.yellow(
        `      ${chalk.bold(outPath)} + its passphrase are the ONLY way to`,
      ),
    );
    this.log(
      chalk.yellow('      recover the Flui master from a platform backup.'),
    );
    this.log(
      chalk.yellow(
        '      Keep them OFF the master and out of this repo. Losing either',
      ),
    );
    this.log(
      chalk.yellow(
        '      makes every platform backup permanently unrecoverable.',
      ),
    );
    this.log(chalk.yellow('   ' + '─'.repeat(68)));
    this.log('');
  }
}
