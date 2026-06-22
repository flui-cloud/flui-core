import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient, ApiError } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { confirmPrompt } from '../../../lib/prompts';

export default class IamGroupDelete extends Command {
  static readonly description =
    'Delete a Flui-local group. Grants targeting this group stop matching.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> acme-team',
    '<%= config.bin %> <%= command.id %> acme-team --yes',
  ];

  static readonly args = {
    name: Args.string({ description: 'Group name', required: true }),
  };

  static readonly flags = {
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip the confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IamGroupDelete);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    if (!flags.yes) {
      const ok = await confirmPrompt(
        `Delete group ${chalk.bold(args.name)}?`,
        false,
      );
      if (!ok) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return;
      }
    }

    const spinner = ora(`Deleting group ${args.name}…`).start();
    try {
      await api.delete<void>(`/iam/groups/${args.name}`);
      spinner.succeed(`Deleted group ${args.name}`);
    } catch (error: unknown) {
      spinner.fail('Failed to delete group');
      if (error instanceof ApiError && error.statusCode === 403) {
        console.log(chalk.yellow('  Requires the iam:assign-role permission.'));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      this.exit(1);
    }
  }
}
