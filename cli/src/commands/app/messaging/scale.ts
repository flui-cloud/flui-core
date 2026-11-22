import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { MessagingClient } from '../../../lib/messaging-client';
import { resolveAppOnAnyCluster } from '../../../lib/resolve-app';

export default class AppMessagingScale extends Command {
  static readonly description =
    'Scale an application on its NATS queue: replicas grow with the consumer’s backlog and go down to --min (0 stops the worker while the queue is empty). Use --off to stop.';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-worker --stream ORDERS --consumer mailer --lag 20 --max 5',
    '<%= config.bin %> <%= command.id %> my-worker --off',
  ];
  static readonly args = {
    app: Args.string({ description: 'Application name or id', required: true }),
  };
  static readonly flags = {
    stream: Flags.string({
      description: 'JetStream stream in the application’s account',
    }),
    consumer: Flags.string({
      description: 'Durable consumer whose backlog is measured',
    }),
    lag: Flags.integer({
      default: 10,
      description: 'Messages waiting per replica before another one is added',
    }),
    min: Flags.integer({
      default: 0,
      description: 'Replicas while the queue is empty',
    }),
    max: Flags.integer({ default: 5, description: 'Most replicas' }),
    off: Flags.boolean({
      default: false,
      description: 'Stop scaling on the queue',
    }),
    from: Flags.string({
      description:
        'Cluster the application runs on, when the name is ambiguous',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppMessagingScale);
    const app = await resolveAppOnAnyCluster(args.app, flags.from);
    const client = MessagingClient.fromConfig();
    if (flags.off) {
      await client.stopScaling(app.id);
      this.log(
        `${chalk.green('✔')} ${app.name} no longer scales on its queue.`,
      );
      return;
    }
    if (!flags.stream || !flags.consumer)
      this.error('--stream and --consumer are required');
    await client.scale(app.id, {
      stream: flags.stream,
      consumer: flags.consumer,
      lagThreshold: flags.lag,
      min: flags.min,
      max: flags.max,
    });
    this.log(
      `${chalk.green('✔')} ${app.name} scales on ${flags.stream}/${flags.consumer}, ${flags.min}–${flags.max} replicas.`,
    );
  }
}
