import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { setBlocked } from '../../../lib/user-block-client';

export default class IamUserBlock extends Command {
  static readonly description =
    'Block a person: every request they make is refused, their sign-in is switched off, and on a demo their space ends. Nothing is deleted; `flui iam user unblock` undoes it.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> someone@example.com --reason "mining in the demo"',
  ];

  static readonly args = {
    who: Args.string({ description: 'Email or user id', required: true }),
  };

  static readonly flags = {
    reason: Flags.string({ description: 'Why, kept with the block' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IamUserBlock);
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    try {
      const state = await setBlocked(api, args.who, true, flags.reason);
      const why = state.blockedReason
        ? ' ' + chalk.dim(state.blockedReason)
        : '';
      this.log(`\n  ${chalk.bold(state.email)} is blocked.${why}\n`);
    } catch (error: unknown) {
      this.error((error as Error).message, { exit: 1 });
    }
  }
}
