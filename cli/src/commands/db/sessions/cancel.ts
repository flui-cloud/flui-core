import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { performSessionAction } from '../../../lib/db-sessions-client';
import { confirmPrompt } from '../../../lib/prompts';

export default class DbSessionsCancel extends Command {
  static readonly description =
    'Cancel the statement a database session is running. The statement fails with an\n' +
    'error in the application that sent it; the connection stays open.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-postgres 4242',
    '<%= config.bin %> <%= command.id %> my-postgres 4242 --yes',
  ];

  static readonly args = {
    db: Args.string({
      description: 'Database application name or id',
      required: true,
    }),
    pid: Args.integer({
      description: 'Session pid, from `flui db sessions`',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or id the database runs on',
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Do not ask for confirmation',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbSessionsCancel);
    try {
      const message = await performSessionAction(
        {
          log: (line) => this.log(line),
          confirm: (question) => confirmPrompt(question, false),
        },
        'cancel',
        { db: args.db, pid: args.pid, cluster: flags.cluster, yes: flags.yes },
      );
      this.log(
        message ? chalk.green(message) : chalk.gray('Nothing cancelled.'),
      );
    } catch (e) {
      this.error(e instanceof Error ? e.message : String(e));
    }
  }
}
