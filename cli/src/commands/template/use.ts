import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface UseTemplateResponse {
  templateRepo: string;
  framework: string;
  fullName: string;
  owner: string;
  name: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  alreadyExisted: boolean;
}

interface ImportRepositoriesResponse {
  imported: number;
  skipped: number;
  repositories: Array<{ id: string; fullName: string; status: string }>;
  errors: string[];
}

export default class TemplateUse extends Command {
  static readonly description =
    'Create a new GitHub repository from a Flui framework template and connect it to your account.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> astro my-astro-site',
    '<%= config.bin %> <%= command.id %> nextjs my-app --public',
    '<%= config.bin %> <%= command.id %> nestjs my-api --org my-org',
  ];

  static readonly args = {
    framework: Args.string({
      description: 'Framework template to use (e.g. astro, nextjs, nestjs)',
      required: true,
    }),
    name: Args.string({
      description: 'Name for the new GitHub repository',
      required: true,
    }),
  };

  static readonly flags = {
    org: Flags.string({
      description:
        'GitHub organisation or user to create the repo under (default: your account)',
    }),
    description: Flags.string({
      char: 'd',
      description: 'Repository description',
    }),
    public: Flags.boolean({
      description: 'Create as a public repository (default: private)',
      default: false,
    }),
    'no-import': Flags.boolean({
      description: 'Skip auto-importing the repository into Flui',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TemplateUse);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();

    const apiClient = new ApiClient({ baseUrl: apiUrl, apiKey: apiKey });

    console.log(
      chalk.cyan(`\n  Creating ${args.framework} app: ${args.name}\n`),
    );

    // ── Step 1: create repo from template ─────────────────────────────────
    const createSpinner = ora('Creating repository from template…').start();
    let repo: UseTemplateResponse;
    try {
      repo = await apiClient.post<UseTemplateResponse>(
        `/templates/${args.framework}/use`,
        {
          name: args.name,
          ...(flags.org ? { owner: flags.org } : {}),
          ...(flags.description ? { description: flags.description } : {}),
          private: !flags.public,
        },
      );

      if (repo.alreadyExisted) {
        createSpinner.warn(
          `Repository ${repo.fullName} already existed — using it`,
        );
      } else {
        createSpinner.succeed(
          `Repository created: ${chalk.bold(repo.fullName)}`,
        );
      }
    } catch (error: unknown) {
      createSpinner.fail('Failed to create repository');
      const msg =
        (error as any).response?.data?.message ?? (error as Error).message;
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }

    // ── Step 2: auto-import into Flui ──────────────────────────────────────
    if (!flags['no-import']) {
      const importSpinner = ora('Connecting repository to Flui…').start();
      try {
        const result = await apiClient.post<ImportRepositoriesResponse>(
          '/repositories/import',
          { repositoryIds: [repo.fullName] },
        );

        if (result.errors?.length > 0) {
          importSpinner.warn(
            `Repository created but connection had issues: ${result.errors.join(', ')}`,
          );
        } else if (result.skipped > 0) {
          importSpinner.succeed('Repository was already connected to Flui');
        } else {
          importSpinner.succeed('Repository connected to Flui');
        }
      } catch (error: unknown) {
        importSpinner.warn(
          'Could not auto-connect repository — connect it manually from the dashboard',
        );
        this.warn(
          (error as any).response?.data?.message ?? (error as Error).message,
        );
      }
    }

    // ── Summary ────────────────────────────────────────────────────────────
    console.log('');
    console.log(`  ${chalk.bold('Repo:')}   ${chalk.cyan(repo.htmlUrl)}`);
    console.log(`  ${chalk.bold('Clone:')}  ${repo.cloneUrl}`);
    console.log('');
    console.log(chalk.dim('  Next steps:'));
    console.log(chalk.dim(`    git clone ${repo.cloneUrl}`));
    console.log(chalk.dim(`    cd ${args.name}`));
    console.log(chalk.dim(`    # Edit flui.yaml as needed`));
    console.log(chalk.dim(`    flui deploy`));
    console.log('');
  }
}
