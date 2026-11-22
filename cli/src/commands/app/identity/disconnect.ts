import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { IdentityClient } from '../../../lib/identity-client';
import { resolveAppOnAnyCluster } from '../../../lib/resolve-app';

export default class AppIdentityDisconnect extends Command {
  static readonly description =
    'Stop signing an application’s users in with its identity install: its client there is deleted and the three variables removed.';
  static readonly examples = ['<%= config.bin %> <%= command.id %> my-shop'];
  static readonly args = {
    app: Args.string({ description: 'Application name or id', required: true }),
  };
  static readonly flags = {
    from: Flags.string({
      description:
        'Cluster the application runs on, when the name is ambiguous',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppIdentityDisconnect);
    const app = await resolveAppOnAnyCluster(args.app, flags.from);
    await IdentityClient.fromConfig().disconnect(app.id);
    this.log(
      `${chalk.green('✔')} ${app.name} no longer signs in through an identity install.`,
    );
  }
}
