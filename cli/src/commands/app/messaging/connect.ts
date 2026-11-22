import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { MessagingClient } from '../../../lib/messaging-client';
import { resolveAppOnAnyCluster } from '../../../lib/resolve-app';

export default class AppMessagingConnect extends Command {
  static readonly description =
    'Give an application its own account on its cluster’s NATS: it receives NATS_URL and NATS_CREDS, and is redeployed. Its subjects and streams are invisible to every other application.';
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
    const { args, flags } = await this.parse(AppMessagingConnect);
    const app = await resolveAppOnAnyCluster(args.app, flags.from);
    const state = await MessagingClient.fromConfig().connect(app.id);
    this.log(
      `${chalk.green('✔')} ${app.name} has its NATS account at ${state.url}`,
    );
  }
}
