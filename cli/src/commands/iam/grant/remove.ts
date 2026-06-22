import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient, ApiError } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { confirmPrompt } from '../../../lib/prompts';

export default class IamGrantRemove extends Command {
  static readonly description = 'Remove an access grant by id.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 3f9a…',
    '<%= config.bin %> <%= command.id %> 3f9a… --yes',
  ];

  static readonly args = {
    id: Args.string({
      description: 'Grant id (from `flui iam grant list`)',
      required: true,
    }),
  };

  static readonly flags = {
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip the confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IamGrantRemove);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    if (!flags.yes) {
      const ok = await confirmPrompt(
        `Remove grant ${chalk.bold(args.id)}?`,
        false,
      );
      if (!ok) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return;
      }
    }

    const spinner = ora(`Removing grant ${args.id}…`).start();
    try {
      await api.delete<void>(`/iam/grants/${args.id}`);
      spinner.succeed(`Removed grant ${args.id}`);
    } catch (error: unknown) {
      spinner.fail('Failed to remove grant');
      if (error instanceof ApiError && error.statusCode === 403) {
        console.log(chalk.yellow('  Requires the iam:assign-role permission.'));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      this.exit(1);
    }
  }
}
