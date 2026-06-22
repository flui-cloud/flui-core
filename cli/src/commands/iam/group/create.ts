import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient, ApiError } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';

const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;

export default class IamGroupCreate extends Command {
  static readonly description =
    'Create a Flui-local group. Name is lowercase letters, digits and hyphens.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> platform',
    '<%= config.bin %> <%= command.id %> acme-team --description "Acme team"',
  ];

  static readonly args = {
    name: Args.string({ description: 'Group name', required: true }),
  };

  static readonly flags = {
    description: Flags.string({ char: 'd', description: 'Group description' }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IamGroupCreate);

    if (!NAME_RE.test(args.name)) {
      this.error(
        'Invalid group name. Use lowercase letters, digits and hyphens (must start with a letter).',
        { exit: 1 },
      );
    }

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    const body: { name: string; description?: string } = { name: args.name };
    if (flags.description) body.description = flags.description;

    let created: { name: string };
    try {
      created = await api.post<{ name: string }>('/iam/groups', body);
    } catch (error: unknown) {
      if (error instanceof ApiError && error.statusCode === 403) {
        this.error('Requires the iam:assign-role permission.', { exit: 1 });
      }
      this.error(`Failed to create group: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(created, null, 2));
      return;
    }

    console.log(
      `\n  ${chalk.green('✓')} Created group ${chalk.bold(created.name)}\n`,
    );
  }
}
