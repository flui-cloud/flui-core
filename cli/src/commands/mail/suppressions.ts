import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface Suppression {
  address: string;
  reason: string;
  scope: string;
  at: string;
  source?: string;
  detail?: string;
}

const REASON_COLOUR: Record<string, (s: string) => string> = {
  complaint: chalk.red,
  bounce: chalk.yellow,
  unsubscribe: chalk.cyan,
  manual: chalk.gray,
};

export default class MailSuppressions extends Command {
  static readonly description = 'Addresses Flui has stopped writing to';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --scope bulk',
  ];

  static readonly flags = {
    scope: Flags.string({
      options: ['all', 'bulk'],
      description: 'Show only entries with this reach',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MailSuppressions);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    const spinner = ora('Reading the suppression list...').start();
    let entries: Suppression[];
    try {
      entries = await new ApiClient({ baseUrl: apiUrl, apiKey }).get<
        Suppression[]
      >('/mail/suppressions');
      spinner.stop();
    } catch (error) {
      spinner.fail('Could not read the suppression list');
      this.error((error as Error).message);
      return;
    }

    const shown = flags.scope
      ? entries.filter((e) => e.scope === flags.scope)
      : entries;

    if (flags.json) {
      this.log(JSON.stringify(shown, null, 2));
      return;
    }

    if (!shown.length) {
      this.log(chalk.dim('\n  Nothing suppressed.\n'));
      return;
    }

    this.log('');
    for (const e of shown) {
      const paint = REASON_COLOUR[e.reason] ?? chalk.white;
      // `bulk` is the interesting one to spot at a glance: it means transactional
      // mail still reaches this person.
      const reach =
        e.scope === 'bulk' ? chalk.dim('bulk only') : chalk.dim('everything');
      this.log(
        `  ${paint(e.reason.padEnd(12))} ${e.address.padEnd(34)} ${reach}  ${chalk.dim(
          e.at.slice(0, 19).replace('T', ' '),
        )}`,
      );
      if (e.detail) this.log(`      ${chalk.dim(e.detail)}`);
    }
    this.log('');
    this.log(
      chalk.dim(
        `  ${shown.length} suppressed. Undo one with \`flui mail unsuppress <address>\`.`,
      ),
    );
    this.log('');
  }
}
