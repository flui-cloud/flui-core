import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { MessagingClient } from '../../../lib/messaging-client';
import { resolveAppOnAnyCluster } from '../../../lib/resolve-app';

export default class AppMessaging extends Command {
  static readonly description =
    'Whether an application has its own account on its cluster’s NATS';
  static readonly examples = ['<%= config.bin %> <%= command.id %> my-worker'];
  static readonly args = {
    app: Args.string({ description: 'Application name or id', required: true }),
  };
  static readonly flags = {
    from: Flags.string({
      description:
        'Cluster the application runs on, when the name is ambiguous',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppMessaging);
    const app = await resolveAppOnAnyCluster(args.app, flags.from);
    const state = await MessagingClient.fromConfig().get(app.id);
    if (flags.json) {
      this.log(JSON.stringify(state, null, 2));
      return;
    }
    if (!state.connected) {
      this.log(
        chalk.dim(
          `${app.name} has no NATS account. Give it one with \`flui app messaging connect\`.`,
        ),
      );
      return;
    }
    this.log(`   address    ${state.url}`);
    this.log(`   account    ${state.account}`);
    this.log(chalk.dim('   variables  NATS_URL, NATS_CREDS (secret)'));
  }
}
