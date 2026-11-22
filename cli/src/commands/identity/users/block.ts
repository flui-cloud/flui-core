import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { IdentityClient } from '../../../lib/identity-client';

export default class IdentityUsersBlock extends Command {
  static readonly description =
    'Stop a person from signing in to the apps of an identity install';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> <install-id> <user-id>',
  ];
  static readonly args = {
    install: Args.string({
      description: 'Identity install id',
      required: true,
    }),
    user: Args.string({
      description: 'User id, as `flui identity users` lists it',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(IdentityUsersBlock);
    await IdentityClient.fromConfig().setBlocked(args.install, args.user, true);
    this.log(`${chalk.green('✔')} Blocked ${args.user}`);
  }
}
