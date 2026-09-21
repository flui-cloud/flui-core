import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient, ApiError } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { openInBrowser } from '../../../lib/browser-callback';
import { promptInput, promptMaskedInput } from '../../../lib/prompts';

interface GhcrPatStatus {
  configured: boolean;
  expiresAt?: string | null;
  githubLogin?: string;
  scopes?: string[];
}

const PAT_PATTERN = /^(ghp_|github_pat_)/;
const DEFAULT_EXPIRY_DAYS = 90;

export default class IntegrationGhcrPatSet extends Command {
  static readonly description =
    'Save (or replace) the GitHub classic PAT used by Flui to pull container images from GHCR. Required for `flui deploy` to work — GitHub App and OAuth tokens cannot read container packages (see https://github.com/orgs/community/discussions/34084).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --headless',
  ];

  static readonly flags = {
    headless: Flags.boolean({
      description:
        'Print the GitHub token-creation URL instead of opening a browser (useful over SSH)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IntegrationGhcrPatSet);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let existing: GhcrPatStatus | null = null;
    try {
      existing = await api.get<GhcrPatStatus>(
        '/repositories/github-app/packages-pat/status',
      );
    } catch {
      /* empty */
    }

    this.printInstructions(existing?.configured ?? false, flags.headless);

    const token = await promptMaskedInput('Token');
    if (!token) {
      this.error('Token cannot be empty', { exit: 1 });
    }
    if (!PAT_PATTERN.test(token)) {
      this.error(
        'Token must start with `ghp_` (classic PAT) or `github_pat_` (fine-grained PAT).',
        { exit: 1 },
      );
    }

    const defaultExpiry = new Date(
      Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);

    const expiry = await promptInput({
      message: 'Expiry date (YYYY-MM-DD, must match the one set on GitHub)',
      default: defaultExpiry,
      validate: (v) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Expected format YYYY-MM-DD';
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return 'Not a valid date';
        if (d.getTime() < Date.now()) return 'Expiry must be in the future';
        return null;
      },
    });
    const expiresAt = new Date(`${expiry}T00:00:00.000Z`).toISOString();

    const action = existing?.configured ? 'Rotating' : 'Saving';
    const endpoint = existing?.configured
      ? '/repositories/github-app/packages-pat/rotate'
      : '/repositories/github-app/packages-pat';
    const method = existing?.configured ? 'put' : 'post';

    const spinner = ora(`${action} GHCR PAT…`).start();
    try {
      const result = await api[method]<GhcrPatStatus>(endpoint, {
        token,
        expiresAt,
      });
      spinner.succeed(`${action.replace(/ing$/, 'ed')} GHCR PAT`);
      this.printResult(result);
    } catch (error: unknown) {
      spinner.fail(`Failed to ${action.toLowerCase()} GHCR PAT`);
      this.printSaveError(error);
      this.exit(1);
    }
  }

  private printResult(result: GhcrPatStatus): void {
    console.log('');
    if (result.githubLogin) {
      console.log(`  GitHub user: ${chalk.bold(result.githubLogin)}`);
    }
    if (result.scopes && result.scopes.length > 0) {
      console.log(`  Scopes:      ${result.scopes.join(', ')}`);
    }
    if (result.expiresAt) {
      console.log(
        `  Expires:     ${new Date(result.expiresAt).toISOString().slice(0, 10)}`,
      );
    }
    console.log('');
    console.log(
      chalk.dim(
        '  You can now `flui deploy`. Set a calendar reminder to rotate before expiry.',
      ),
    );
    console.log('');
  }

  private printSaveError(error: unknown): void {
    if (error instanceof ApiError && error.statusCode === 400) {
      console.log(chalk.red(`  ${error.message}`));
      console.log(
        chalk.yellow(
          '  GitHub rejected the token. Check it has read:packages scope and is not expired.',
        ),
      );
      return;
    }
    console.log(chalk.red(`  ${(error as Error).message}`));
  }

  private printInstructions(
    alreadyConfigured: boolean,
    headless: boolean,
  ): void {
    const prefilledUrl =
      'https://github.com/settings/tokens/new?scopes=read:packages,delete:packages&description=Flui+GHCR+pull';
    console.log('');
    if (alreadyConfigured) {
      console.log(
        chalk.yellow(
          '  A GHCR PAT is already configured. This will replace it.',
        ),
      );
      console.log('');
    }
    console.log(
      `  ${chalk.bold('Generate a GitHub Personal Access Token (classic)')}`,
    );
    console.log('');

    const opened = !headless && openInBrowser(prefilledUrl);
    if (opened) {
      console.log(chalk.dim('  Opened browser at the token-creation page.'));
      console.log(chalk.dim('  If it did not open, use this URL:'));
      console.log(`  ${chalk.cyan(prefilledUrl)}`);
    } else {
      console.log(`  Pre-filled link (scopes already set):`);
      console.log(`  ${chalk.cyan(prefilledUrl)}`);
    }
    console.log('');
    console.log(
      `  Required scopes: ${chalk.bold('read:packages')} ${chalk.dim('(or write:packages)')}`,
    );
    console.log(
      `  Recommended:     ${chalk.bold('delete:packages')} ${chalk.dim('(lets Flui clean up old images)')}`,
    );
    console.log(
      `  Expiry:          ${chalk.dim('pick a date (90 days is a sensible default)')}`,
    );
    console.log('');
    console.log(
      chalk.dim(
        '  Fine-grained PATs (github_pat_…) are also accepted as long as',
      ),
    );
    console.log(
      chalk.dim('  they grant Packages: read on the relevant org/account.'),
    );
    console.log('');
  }
}
