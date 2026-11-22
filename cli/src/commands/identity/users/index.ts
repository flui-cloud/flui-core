import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { IdentityClient } from '../../../lib/identity-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class IdentityUsers extends Command {
  static readonly description =
    'People who can sign in to the apps connected to an identity install';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> <install-id>',
  ];
  static readonly args = {
    install: Args.string({
      description: 'Identity install id',
      required: true,
    }),
  };
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IdentityUsers);
    const users = await IdentityClient.fromConfig().users(args.install);
    if (flags.json) {
      this.log(JSON.stringify(users, null, 2));
      return;
    }
    printContextBanner();
    if (users.length === 0) {
      this.log(
        chalk.dim(
          '\n   Nobody yet. Invite someone with `flui identity users invite`.\n',
        ),
      );
      return;
    }
    this.log('');
    for (const u of users) {
      const state =
        u.state === 'active' ? chalk.green(u.state) : chalk.yellow(u.state);
      this.log(
        `   ${u.username.padEnd(36)} ${state.padEnd(18)} ${chalk.dim(u.id)}`,
      );
    }
    this.log('');
  }
}
