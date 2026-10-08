import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { setBlocked } from '../../../lib/user-block-client';

export default class IamUserUnblock extends Command {
  static readonly description = 'Let a blocked person in again.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> someone@example.com',
  ];

  static readonly args = {
    who: Args.string({ description: 'Email or user id', required: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(IamUserUnblock);
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    try {
      const state = await setBlocked(api, args.who, false);
      this.log(`\n  ${chalk.bold(state.email)} can sign in again.\n`);
    } catch (error: unknown) {
      this.error((error as Error).message, { exit: 1 });
    }
  }
}
