import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { listUsers, userLine } from '../../../lib/user-list';

export default class IamUserList extends Command {
  static readonly description =
    'The people who can sign in, and the demo’s visitors, each marked with its kind. Block one with `flui iam user block`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --kind visitor',
    '<%= config.bin %> <%= command.id %> --email example.com',
  ];

  static readonly flags = {
    kind: Flags.string({
      description: 'Only visitors of the demo, or only everybody else',
      options: ['person', 'visitor'],
    }),
    email: Flags.string({ description: 'Only addresses containing this' }),
    limit: Flags.integer({ description: 'At most this many', default: 100 }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IamUserList);
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    try {
      const users = await listUsers(api, {
        kind: flags.kind as 'person' | 'visitor' | undefined,
        email: flags.email,
        limit: flags.limit,
      });
      if (flags.json) {
        this.log(JSON.stringify(users, null, 2));
        return;
      }
      this.log('');
      if (users.length === 0) {
        this.log(chalk.dim('   Nobody here.'));
      }
      for (const user of users.filter((u) => !u.isSystemUser)) {
        this.log(userLine(user));
      }
      this.log('');
    } catch (error: unknown) {
      this.error((error as Error).message, { exit: 1 });
    }
  }
}
