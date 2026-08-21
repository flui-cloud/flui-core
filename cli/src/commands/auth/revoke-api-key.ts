import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

export default class AuthRevokeApiKey extends Command {
  static readonly description =
    'Revoke an API key by id. The key stops working immediately; nothing else is affected.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 6f1c2d34-...',
  ];

  static readonly args = {
    id: Args.string({
      description: 'Key id, as shown by `flui auth api-keys`',
      required: true,
    }),
  };

  static readonly flags = {
    profile: Flags.string({
      description:
        'Profile to read the credential from (default: active profile)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AuthRevokeApiKey);

    const storage = new ConfigStorage(flags.profile);
    const apiUrl = storage.getApiUrlOrThrow();
    const apiKey = storage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    try {
      await api.delete(`/auth/api-keys/${args.id}`);
    } catch (error: unknown) {
      this.error(`Failed to revoke key: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    this.log(chalk.green(`✔ API key ${args.id} revoked`));
  }
}
