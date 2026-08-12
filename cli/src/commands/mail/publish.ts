import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface PublishResult {
  domain: string;
  verified: boolean;
  canWrite: boolean;
  published: string[];
  outstanding: { name: string; kind: string; value: string; purpose: string }[];
  error?: string;
}

export default class MailPublish extends Command {
  static readonly description =
    'Register a sending domain with the provider and publish the records it needs';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> example.com',
  ];

  static readonly args = {
    domain: Args.string({ required: true, description: 'The sending domain' }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(MailPublish);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    const spinner = ora(`Registering ${args.domain}...`).start();
    let result: PublishResult;
    try {
      result = await new ApiClient({
        baseUrl: apiUrl,
        apiKey,
      }).post<PublishResult>(
        `/mail/domains/${encodeURIComponent(args.domain)}/publish`,
      );
      spinner.stop();
    } catch (error) {
      spinner.fail('Could not register the domain');
      this.error((error as Error).message);
      return;
    }

    this.log('');
    for (const record of result.published) {
      this.log(`  ${chalk.green('✓')} published  ${record}`);
    }

    if (result.outstanding.length) {
      this.log('');
      this.log(
        result.canWrite
          ? `  ${chalk.yellow('Still outstanding:')}`
          : `  ${chalk.yellow('Flui does not hold this zone — publish these yourself:')}`,
      );
      this.log('');
      for (const r of result.outstanding) {
        this.log(`  ${chalk.bold(r.kind.padEnd(6))} ${r.name}`);
        this.log(`         ${chalk.dim(r.value)}`);
      }
    }

    if (result.error) {
      this.log('');
      this.log(
        `  ${chalk.red('Some records could not be written:')} ${result.error}`,
      );
    }

    this.log('');
    this.log(
      result.verified
        ? `  ${chalk.green('The provider has verified this domain.')}`
        : chalk.dim(
            '  Not verified yet. The provider re-reads DNS on its own schedule and lags\n' +
              '  propagation by minutes — check with `flui mail readiness --domain ' +
              `${result.domain}\`.`,
          ),
    );
    this.log('');
  }
}
