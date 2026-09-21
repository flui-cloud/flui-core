import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient, ApiError } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { selectWithArrows } from '../../lib/prompts';

interface AvailableRepo {
  fullName: string;
  name: string;
  owner: string;
  description?: string;
  private: boolean;
  defaultBranch: string;
}

interface ImportResponse {
  imported?: number;
  skipped?: number;
  failed?: number;
  repositories?: Array<{ id: string; fullName: string; status: string }>;
  errors?: string[];
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

export default class RepoConnect extends Command {
  static readonly description =
    'Connect (import) a GitHub repository into your Flui account so it can be deployed with `flui deploy`. ' +
    'Pass the full name `owner/repo`, or omit it for an interactive picker over the repositories accessible via your GitHub integration.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> acme/my-app',
    '<%= config.bin %> <%= command.id %>',
  ];

  static readonly args = {
    repo: Args.string({
      description:
        'Full repository name `owner/repo`. Omit to pick interactively.',
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(RepoConnect);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    const target = args.repo ?? (await this.pickInteractively(api));
    if (!target) {
      console.log(chalk.dim('\n  Cancelled.\n'));
      return;
    }

    if (!/^[^/]+\/[^/]+$/.test(target)) {
      this.error(
        `Invalid repository name "${target}". Expected format: owner/repo`,
        { exit: 1 },
      );
    }

    const spinner = ora(`Connecting ${chalk.bold(target)}…`).start();
    try {
      const result = await api.post<ImportResponse>('/repositories/import', {
        repositoryIds: [target],
      });
      this.handleImportResult(spinner, target, result);
    } catch (error: unknown) {
      spinner.fail('Failed to connect repository');
      this.printImportError(error);
      this.exit(1);
    }
  }

  private handleImportResult(
    spinner: ReturnType<typeof ora>,
    target: string,
    result: ImportResponse,
  ): void {
    const errors = result?.errors ?? [];
    const skipped = result?.skipped ?? 0;
    const imported = result?.imported ?? 0;

    if (errors.length > 0) {
      spinner.fail(`Could not connect ${target}`);
      for (const err of errors) {
        console.log(chalk.red(`  ${err}`));
      }
      console.log(
        chalk.dim(
          '\n  If the repository is private or was just created, the GitHub App may not yet ' +
            'have access to it. Add it on github.com/settings/installations and retry.\n',
        ),
      );
      this.exit(1);
    }
    if (skipped > 0 && imported === 0) {
      spinner.succeed(`${target} was already connected`);
    } else {
      spinner.succeed(`Connected ${target}`);
    }
  }

  private printImportError(error: unknown): void {
    if (error instanceof ApiError && error.statusCode === 404) {
      console.log(
        chalk.yellow(
          '\n  No active GitHub connection. Run `flui integration connect github` first.\n',
        ),
      );
      return;
    }
    const msg = formatErrorMessage(error);
    console.log(chalk.red(`  ${msg}`));
    if (msg.includes('Cannot read properties')) {
      console.log(
        chalk.dim(
          '\n  Unexpected API response shape. Run `flui repo list` to check whether the ' +
            'repository was actually imported despite the error.\n',
        ),
      );
    }
  }

  private async pickInteractively(api: ApiClient): Promise<string | undefined> {
    if (!process.stdin.isTTY) {
      this.error(
        'Repository name is required in non-interactive mode. ' +
          'Pass it as an argument: `flui repo connect <owner/repo>`.',
        { exit: 1 },
      );
    }

    const spinner = ora('Fetching repositories from GitHub…').start();
    let available: AvailableRepo[];
    try {
      available = await api.get<AvailableRepo[]>('/repositories/available');
      spinner.stop();
    } catch (error: unknown) {
      spinner.fail('Failed to fetch repositories');
      if (error instanceof ApiError && error.statusCode === 404) {
        console.log(
          chalk.yellow(
            '\n  No active GitHub connection. Run `flui integration connect github` first.\n',
          ),
        );
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      this.exit(1);
    }

    if (available.length === 0) {
      console.log(
        chalk.dim(
          '\n  No repositories available to connect (all are already connected, ' +
            'or the GitHub App has no repos selected on its installation).\n',
        ),
      );
      return undefined;
    }

    const choice = await selectWithArrows(
      `Select a repository to connect:`,
      available.map((r) => ({
        label: `${r.fullName}${r.description ? chalk.dim(' — ' + r.description.slice(0, 60)) : ''}`,
      })),
    );

    if (choice === -1) return undefined;
    return available[choice].fullName;
  }
}
