import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { performPooledClientClose } from '../../../lib/db-sessions-client';
import { confirmPrompt } from '../../../lib/prompts';

export default class DbSessionsCloseClient extends Command {
  static readonly description =
    'Close a connection held by the pooler of a managed PostgreSQL. The server\n' +
    'connection it holds is closed too, its open transaction rolled back, and the\n' +
    'application has to reconnect. Client ids are listed by `flui db sessions`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-postgres 17',
    '<%= config.bin %> <%= command.id %> my-postgres 17 --pod my-postgres-pooler-6f9c-x2 --yes',
  ];

  static readonly args = {
    db: Args.string({
      description: 'Database application name or id',
      required: true,
    }),
    client: Args.integer({
      description: 'Pooled client id, from `flui db sessions`',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or id the database runs on',
    }),
    pod: Flags.string({
      description: 'Pooler pod holding the client, when it runs more than one',
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Do not ask for confirmation',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbSessionsCloseClient);
    try {
      const message = await performPooledClientClose(
        {
          log: (line) => this.log(line),
          confirm: (question) => confirmPrompt(question, false),
        },
        {
          db: args.db,
          clientId: args.client,
          pod: flags.pod,
          cluster: flags.cluster,
          yes: flags.yes,
        },
      );
      this.log(message ? chalk.green(message) : chalk.gray('Nothing closed.'));
    } catch (e) {
      this.error(e instanceof Error ? e.message : String(e));
    }
  }
}
