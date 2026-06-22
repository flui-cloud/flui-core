import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient, ApiError } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';

interface IamGroup {
  name: string;
  members: string[];
}

export default class IamGroupAddMember extends Command {
  static readonly description =
    'Add a member (by email) to a Flui-local group.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> platform alice@acme.com',
  ];

  static readonly args = {
    name: Args.string({ description: 'Group name', required: true }),
    email: Args.string({ description: 'Member email', required: true }),
  };

  static readonly flags = {
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IamGroupAddMember);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let group: IamGroup;
    try {
      group = await api.post<IamGroup>(
        `/iam/groups/${args.name}/members/${encodeURIComponent(args.email)}`,
      );
    } catch (error: unknown) {
      if (error instanceof ApiError && error.statusCode === 403) {
        this.error('Requires the iam:assign-role permission.', { exit: 1 });
      }
      this.error(`Failed to add member: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(group, null, 2));
      return;
    }

    console.log(
      `\n  ${chalk.green('✓')} Added ${chalk.bold(args.email)} to ${chalk.bold(args.name)} ${chalk.dim(`(${group.members.length} members)`)}\n`,
    );
  }
}
