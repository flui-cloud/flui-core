import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

export default class MailUnsuppress extends Command {
  static readonly description = 'Start writing to a suppressed address again';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> someone@example.com',
  ];

  static readonly args = {
    address: Args.string({
      required: true,
      description: 'The address to release',
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(MailUnsuppress);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    const spinner = ora(`Releasing ${args.address}...`).start();
    try {
      await new ApiClient({ baseUrl: apiUrl, apiKey }).delete(
        `/mail/suppressions/${encodeURIComponent(args.address)}`,
      );
      // Silent on "was not there" on purpose: the caller asked for an address to
      // be sendable, and it is. Distinguishing the two states helps nobody.
      spinner.succeed(`${args.address} will receive mail again`);
    } catch (error) {
      spinner.fail('Could not release the address');
      this.error((error as Error).message);
    }

    this.log('');
    this.log(
      chalk.dim(
        '  If the address bounces again it will be suppressed again — this clears the record,\n' +
          '  it does not vouch for the mailbox.',
      ),
    );
    this.log('');
  }
}
