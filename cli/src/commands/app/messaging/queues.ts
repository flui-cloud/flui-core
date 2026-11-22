import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { MessagingClient } from '../../../lib/messaging-client';
import { resolveAppOnAnyCluster } from '../../../lib/resolve-app';

export default class AppMessagingQueues extends Command {
  static readonly description =
    'The queues in an application’s NATS account; with --create or --delete, change them';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-worker',
    '<%= config.bin %> <%= command.id %> my-worker --create ORDERS --max-age 168 --max-deliver 5 --dead-letter',
    '<%= config.bin %> <%= command.id %> my-worker --delete ORDERS',
  ];
  static readonly args = {
    app: Args.string({ description: 'Application name or id', required: true }),
  };
  static readonly flags = {
    create: Flags.string({ description: 'Name of a queue to create' }),
    delete: Flags.string({
      description: 'Name of a queue to delete, with all its messages',
    }),
    'max-age': Flags.integer({
      default: 168,
      description: 'Hours an unhandled message is kept',
    }),
    'max-deliver': Flags.integer({
      default: 5,
      description: 'Deliveries before a message is given up on',
    }),
    'dead-letter': Flags.boolean({
      default: true,
      allowNo: true,
      description: 'Keep messages given up on in NAME_DLQ',
    }),
    from: Flags.string({
      description:
        'Cluster the application runs on, when the name is ambiguous',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppMessagingQueues);
    const app = await resolveAppOnAnyCluster(args.app, flags.from);
    const client = MessagingClient.fromConfig();
    let queues;
    if (flags.create) {
      queues = await client.createQueue(app.id, {
        name: flags.create,
        maxAgeHours: flags['max-age'],
        maxDeliver: flags['max-deliver'],
        deadLetter: flags['dead-letter'],
      });
    } else if (flags.delete) {
      queues = await client.deleteQueue(app.id, flags.delete);
    } else {
      queues = await client.queues(app.id);
    }
    if (flags.json) {
      this.log(JSON.stringify(queues, null, 2));
      return;
    }
    if (queues.length === 0) {
      this.log(chalk.dim('No queues.'));
      return;
    }
    for (const q of queues) {
      const dead = q.deadLetters === null ? '' : `  given up ${q.deadLetters}`;
      this.log(
        `   ${q.name.padEnd(24)} waiting ${String(q.waiting).padEnd(6)} in flight ${String(q.inFlight).padEnd(5)}${dead}`,
      );
    }
  }
}
