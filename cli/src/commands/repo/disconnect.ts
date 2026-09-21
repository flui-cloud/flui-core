import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient, ApiError } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { confirmPrompt } from '../../lib/prompts';

interface ConnectedRepo {
  id: string;
  repositoryFullName: string;
}

export default class RepoDisconnect extends Command {
  static readonly description =
    'Disconnect a repository from your Flui account. Requires admin privileges. Does not delete the repository on GitHub.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> acme/my-app',
    '<%= config.bin %> <%= command.id %> acme/my-app --yes',
  ];

  static readonly args = {
    repo: Args.string({
      description: 'Full repository name `owner/repo`',
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
    const { args, flags } = await this.parse(RepoDisconnect);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    const all = await api
      .get<ConnectedRepo[]>('/repositories')
      .catch((err: unknown) => {
        this.error(
          `Failed to look up repositories: ${(err as Error).message}`,
          { exit: 1 },
        );
      });

    const match = all?.find((r) => r.repositoryFullName === args.repo);
    if (!match) {
      this.error(
        `Repository "${args.repo}" is not connected. Run \`flui repo list\` to see what is.`,
        { exit: 1 },
      );
    }

    if (!flags.yes) {
      const ok = await confirmPrompt(
        `Disconnect ${chalk.bold(args.repo)} from Flui?`,
        false,
      );
      if (!ok) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return;
      }
    }

    const spinner = ora(`Disconnecting ${args.repo}…`).start();
    try {
      await api.delete<void>(`/repositories/${match.id}`);
      spinner.succeed(`Disconnected ${args.repo}`);
    } catch (error: unknown) {
      spinner.fail('Failed to disconnect repository');
      if (error instanceof ApiError && error.statusCode === 403) {
        console.log(
          chalk.yellow('  Admin privileges required for this operation.'),
        );
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      this.exit(1);
    }
  }
}
