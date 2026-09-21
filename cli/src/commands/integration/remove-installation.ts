import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient, ApiError } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { confirmPrompt } from '../../lib/prompts';

export default class IntegrationRemoveInstallation extends Command {
  static readonly description =
    'Remove a GitHub App installation record from the Flui database. Requires admin privileges. Does NOT uninstall the app on GitHub — uninstall it there first, otherwise the next webhook will re-create the record.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 12345678',
    '<%= config.bin %> <%= command.id %> 12345678 --yes',
  ];

  static readonly args = {
    installationId: Args.string({
      description:
        'GitHub installation ID (numeric). Get it with `flui integration installations`.',
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
    const { args, flags } = await this.parse(IntegrationRemoveInstallation);

    const installationId = Number(args.installationId);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      this.error(
        `Invalid installation ID "${args.installationId}". Must be a positive integer.`,
        { exit: 1 },
      );
    }

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    if (!flags.yes) {
      const ok = await confirmPrompt(
        `Remove GitHub App installation ${chalk.bold(installationId)} from Flui's database?`,
        false,
      );
      if (!ok) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return;
      }
    }

    const spinner = ora(`Removing installation ${installationId}…`).start();
    try {
      await api.delete<void>(
        `/repositories/github-app/installations/${installationId}`,
      );
      spinner.succeed(`Removed installation ${installationId}`);
    } catch (error: unknown) {
      spinner.fail('Failed to remove installation');
      if (error instanceof ApiError && error.statusCode === 403) {
        console.log(
          chalk.yellow('  Admin privileges required for this operation.'),
        );
      } else if (error instanceof ApiError && error.statusCode === 404) {
        console.log(
          chalk.yellow(
            `  No installation with ID ${installationId} found. Run \`flui integration installations\` to list tracked ones.`,
          ),
        );
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      this.exit(1);
    }
  }
}
