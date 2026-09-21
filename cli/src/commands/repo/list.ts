import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface ConnectedRepo {
  id: string;
  provider: string;
  repositoryName: string;
  repositoryFullName: string;
  owner: string;
  defaultBranch: string;
  isPrivate: boolean;
  htmlUrl: string;
  language?: string;
  autoDeployEnabled: boolean;
}

export default class RepoList extends Command {
  static readonly description =
    'List repositories connected to your Flui account.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --output json',
  ];

  static readonly flags = {
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RepoList);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let repos: ConnectedRepo[];
    try {
      repos = await api.get<ConnectedRepo[]>('/repositories');
    } catch (error: unknown) {
      this.error(`Failed to list repositories: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(repos, null, 2));
      return;
    }

    if (repos.length === 0) {
      console.log(chalk.dim('\n  No repositories connected.'));
      console.log(
        chalk.dim(
          '  Connect one with `flui repo connect <owner/repo>` ' +
            '(or `flui integration connect github` first if GitHub is not yet connected).\n',
        ),
      );
      return;
    }

    const refW = Math.max(...repos.map((r) => r.repositoryFullName.length), 4);
    const langW = Math.max(...repos.map((r) => (r.language ?? '-').length), 4);

    console.log('');
    console.log(
      `  ${chalk.bold('REPOSITORY'.padEnd(refW))}  ${chalk.bold('BRANCH'.padEnd(8))}  ${chalk.bold('LANG'.padEnd(langW))}  ${chalk.bold('AUTO-DEPLOY')}`,
    );
    console.log(
      `  ${'─'.repeat(refW)}  ${'─'.repeat(8)}  ${'─'.repeat(langW)}  ${'─'.repeat(11)}`,
    );
    for (const r of repos) {
      const autoDeploy = r.autoDeployEnabled
        ? chalk.green('on')
        : chalk.dim('off');
      console.log(
        `  ${r.repositoryFullName.padEnd(refW)}  ${r.defaultBranch.padEnd(8)}  ${(r.language ?? '-').padEnd(langW)}  ${autoDeploy}`,
      );
    }
    console.log('');
  }
}
