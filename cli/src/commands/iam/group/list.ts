import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';

interface IamGroup {
  name: string;
  description: string | null;
  members: string[];
}

export default class IamGroupList extends Command {
  static readonly description =
    'List Flui-local groups (membership lives in Flui, not the IdP).';

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
    const { flags } = await this.parse(IamGroupList);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let groups: IamGroup[];
    try {
      groups = await api.get<IamGroup[]>('/iam/groups');
    } catch (error: unknown) {
      this.error(`Failed to list groups: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(groups, null, 2));
      return;
    }

    if (groups.length === 0) {
      console.log(chalk.dim('\n  No groups yet.'));
      console.log(
        chalk.dim('  Create one with `flui iam group create <name>`.\n'),
      );
      return;
    }

    console.log('');
    for (const g of groups) {
      const count = `${g.members.length} member${g.members.length === 1 ? '' : 's'}`;
      console.log(`  ${chalk.bold(g.name)} ${chalk.dim(`· ${count}`)}`);
      if (g.description) console.log(`  ${chalk.dim(g.description)}`);
      if (g.members.length) {
        console.log(`  ${g.members.map((m) => chalk.cyan(m)).join(', ')}`);
      }
      console.log('');
    }
  }
}
