import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { performSessionAction } from '../../../lib/db-sessions-client';
import { confirmPrompt } from '../../../lib/prompts';

export default class DbSessionsTerminate extends Command {
  static readonly description =
    'Close a database session. Its open transaction, if any, is rolled back and the\n' +
    'application has to reconnect. Prefer `flui db sessions cancel` when stopping the statement is enough.';

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
    const { args, flags } = await this.parse(DbSessionsTerminate);
    try {
      const message = await performSessionAction(
        {
          log: (line) => this.log(line),
          confirm: (question) => confirmPrompt(question, false),
        },
        'terminate',
        { db: args.db, pid: args.pid, cluster: flags.cluster, yes: flags.yes },
      );
      this.log(message ? chalk.green(message) : chalk.gray('Nothing closed.'));
    } catch (e) {
      this.error(e instanceof Error ? e.message : String(e));
    }
  }
}
