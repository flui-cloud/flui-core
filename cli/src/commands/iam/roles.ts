import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface IamRoleDef {
  key: string;
  name: string;
  description: string;
  permissions: string[];
}

export default class IamRoles extends Command {
  static readonly description =
    'List the built-in access roles and the permissions each one grants.';

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
    const { flags } = await this.parse(IamRoles);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let roles: IamRoleDef[];
    try {
      roles = await api.get<IamRoleDef[]>('/iam/roles');
    } catch (error: unknown) {
      this.error(`Failed to list roles: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(roles, null, 2));
      return;
    }

    console.log('');
    for (const r of roles) {
      console.log(`  ${chalk.bold(r.name)} ${chalk.dim(`(${r.key})`)}`);
      console.log(`  ${chalk.dim(r.description)}`);
      console.log(`  ${r.permissions.map((p) => chalk.cyan(p)).join(', ')}`);
      console.log('');
    }
  }
}
