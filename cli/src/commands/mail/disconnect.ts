import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

export default class MailDisconnect extends Command {
  static readonly description = 'Disconnect a mail provider';

  static readonly examples = ['<%= config.bin %> <%= command.id %> <id> --yes'];

  static readonly args = {
    id: Args.string({
      description: 'Connection id, from `flui mail providers --json`',
      required: true,
    }),
  };

  static readonly flags = {
    yes: Flags.boolean({
      default: false,
      description: 'Required. The stored credential is destroyed.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MailDisconnect);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    if (!flags.yes) {
      this.log('');
      this.log(
        `  Disconnecting ${chalk.bold(args.id)} destroys the stored credential.`,
      );
      this.log(
        '  Flui polls once more first, so a bounce still in flight is not lost —',
      );
      this.log('  the domain stays registered at the provider either way.');
      this.log('');
      this.log(chalk.dim('  Re-run with --yes to go ahead.\n'));
      return;
    }

    const spinner = ora('Disconnecting...').start();
    try {
      await new ApiClient({ baseUrl: apiUrl, apiKey }).delete(
        `/mail/connections/${encodeURIComponent(args.id)}`,
      );
      spinner.stop();
    } catch (error) {
      spinner.fail('The provider could not be disconnected');
      this.error((error as Error).message);
      return;
    }

    this.log('');
    this.log(`  ${chalk.green('✓')} Disconnected.\n`);
  }
}
