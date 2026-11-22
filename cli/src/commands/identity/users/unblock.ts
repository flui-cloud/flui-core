import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { IdentityClient } from '../../../lib/identity-client';

export default class IdentityUsersUnblock extends Command {
  static readonly description = 'Let a blocked person sign in again';
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
    const { args } = await this.parse(IdentityUsersUnblock);
    await IdentityClient.fromConfig().setBlocked(
      args.install,
      args.user,
      false,
    );
    this.log(`${chalk.green('✔')} Unblocked ${args.user}`);
  }
}
