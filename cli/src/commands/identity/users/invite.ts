import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { IdentityClient } from '../../../lib/identity-client';

export default class IdentityUsersInvite extends Command {
  static readonly description =
    'Invite a person to an identity install; the identity server mails the invitation';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> <install-id> --email alice@example.com --given-name Alice --family-name Doe',
  ];
  static readonly args = {
    install: Args.string({
      description: 'Identity install id',
      required: true,
    }),
  };
  static readonly flags = {
    email: Flags.string({ required: true, description: 'Email of the person' }),
    'given-name': Flags.string({ required: true }),
    'family-name': Flags.string({ required: true }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IdentityUsersInvite);
    const { id } = await IdentityClient.fromConfig().invite(args.install, {
      email: flags.email,
      givenName: flags['given-name'],
      familyName: flags['family-name'],
    });
    this.log(
      `${chalk.green('✔')} Invited ${flags.email} ${chalk.dim('(' + id + ')')}`,
    );
  }
}
