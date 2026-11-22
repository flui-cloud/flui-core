import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { MessagingClient } from '../../../lib/messaging-client';
import { resolveAppOnAnyCluster } from '../../../lib/resolve-app';

export default class AppMessagingDisconnect extends Command {
  static readonly description =
    'Take an application’s account off its cluster’s NATS: NATS_URL and NATS_CREDS are removed and it is redeployed.';
  static readonly examples = ['<%= config.bin %> <%= command.id %> my-worker'];
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
    const { args, flags } = await this.parse(AppMessagingDisconnect);
    const app = await resolveAppOnAnyCluster(args.app, flags.from);
    await MessagingClient.fromConfig().disconnect(app.id);
    this.log(`${chalk.green('✔')} ${app.name} no longer has a NATS account.`);
  }
}
