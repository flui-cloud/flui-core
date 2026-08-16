import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { VaultFile } from '../../lib/vault/vault-file';
import { promptMaskedInput } from '../../lib/prompts';
import { refuseToAsk } from '../../lib/non-interactive';
import { stdinRequested, stdinValue } from '../../lib/stdin-value';

/** Four words from a short list beat a password nobody can remember. */
const WORDS = [
  'anchor',
  'basil',
  'cobalt',
  'dahlia',
  'ember',
  'fjord',
  'gravel',
  'harbor',
  'indigo',
  'juniper',
  'kelp',
  'lantern',
  'marble',
  'nectar',
  'onyx',
  'pebble',
  'quartz',
  'ridge',
  'saffron',
  'thistle',
  'umber',
  'verbena',
  'willow',
  'yarrow',
  'amber',
  'birch',
  'cedar',
  'delta',
  'elder',
  'flint',
  'garnet',
  'hollow',
];

function suggestPassphrase(): string {
  const bytes = randomBytes(5);
  return Array.from(
    { length: 5 },
    (_, i) => WORDS[bytes[i] % WORDS.length],
  ).join('-');
}

/**
 * Sets up the vault that protects everything this CLI stores.
 *
 * It comes first on purpose. Until it exists, a provider token saved on this
 * machine is sealed with a key sitting in the same directory — which is to say
 * not really sealed at all. Asking for the passphrase here, while the operator
 * is already setting things up, is also the only moment they are in the right
 * frame of mind to write it down.
 */
export default class VaultInit extends Command {
  static readonly description =
    'Create the vault that protects stored credentials on this machine. Run this before configuring anything else.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    'printf "my passphrase" | <%= config.bin %> <%= command.id %> --stdin',
  ];

  static readonly flags = {
    stdin: Flags.boolean({
      description:
        'Read the passphrase from standard input rather than prompting. For scripted setup; the value never appears in the process list.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(VaultInit);
    const vault = new VaultFile();

    if (vault.exists()) {
      this.log(
        chalk.yellow(`\nA vault already exists at ${vault.location}.\n`),
      );
      this.log(chalk.dim('   Unlock it with:  flui vault unlock'));
      this.log(
        chalk.dim(
          '   Rewriting it would make every credential stored on this machine unreadable,\n' +
            '   so this command will not do it.\n',
        ),
      );
      this.exit(1);
    }

    const passphrase =
      flags.stdin || stdinRequested()
        ? stdinValue()
        : await this.askForPassphrase();

    if (!passphrase) {
      this.error('A vault passphrase cannot be empty.', { exit: 1 });
    }

    vault.init(passphrase);

    this.log(chalk.green(`\n✅ Vault created at ${vault.location}\n`));
    this.log(
      chalk.yellow(
        '   Write the passphrase down somewhere safe, now.\n' +
          '   It is not stored anywhere and cannot be recovered or reset. Losing it\n' +
          '   means losing every credential this machine has sealed.\n',
      ),
    );
    this.log(chalk.cyan('   Next:\n'));
    this.log(
      `   ${chalk.cyan('flui vault unlock')}      open it for this session`,
    );
    this.log(
      `   ${chalk.cyan('flui config set hetzner --stdin')}   store a provider token\n`,
    );
  }

  private async askForPassphrase(): Promise<string> {
    refuseToAsk(
      'a vault passphrase',
      'Pass it on standard input instead:  printf "…" | flui vault init --stdin',
    );

    const suggestion = suggestPassphrase();
    this.log(chalk.cyan('\n🔐 Choose a passphrase for this machine\n'));
    this.log(
      chalk.dim(
        '   It protects the provider tokens and keys stored under ~/.flui.\n' +
          '   You will be asked for it once per session, not once per command.\n',
      ),
    );
    this.log(
      chalk.dim(
        `   Suggestion (press enter to accept):  ${chalk.bold(suggestion)}\n`,
      ),
    );

    const first =
      (await promptMaskedInput('  Passphrase')).trim() || suggestion;
    const second =
      (await promptMaskedInput('  Repeat it')).trim() || suggestion;

    if (first !== second) {
      // Checked before anything is written: a mistyped passphrase confirmed by
      // a matching typo is recoverable, one written into the salt is not.
      this.error(
        'Those do not match. Nothing was written; run the command again.',
        {
          exit: 1,
        },
      );
    }
    return first;
  }
}
