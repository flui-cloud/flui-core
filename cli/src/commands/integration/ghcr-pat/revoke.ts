import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient, ApiError } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { confirmPrompt } from '../../../lib/prompts';

export default class IntegrationGhcrPatRevoke extends Command {
  static readonly description =
    'Revoke the GHCR PAT stored in Flui. Does NOT revoke the token on GitHub — do that separately at https://github.com/settings/tokens. After revoking, `flui deploy` will fail until a new PAT is set.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --yes',
  ];

  static readonly flags = {
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip the confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IntegrationGhcrPatRevoke);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    if (!flags.yes) {
      const ok = await confirmPrompt(
        'Revoke the stored GHCR PAT? Future `flui deploy` will fail until a new one is set.',
        false,
      );
      if (!ok) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return;
      }
    }

    const spinner = ora('Revoking GHCR PAT…').start();
    try {
      await api.delete<void>('/repositories/github-app/packages-pat');
      spinner.succeed('GHCR PAT revoked');
      console.log('');
      console.log(
        chalk.yellow(
          '  Remember to also delete it on GitHub at https://github.com/settings/tokens',
        ),
      );
      console.log('');
    } catch (error: unknown) {
      spinner.fail('Failed to revoke GHCR PAT');
      if (error instanceof ApiError && error.statusCode === 404) {
        console.log(chalk.dim('  No PAT was configured.'));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      this.exit(1);
    }
  }
}
