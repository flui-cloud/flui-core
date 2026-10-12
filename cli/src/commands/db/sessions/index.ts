import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { DbSessionsClient } from '../../../lib/db-sessions-client';
import {
  DbSessionsView,
  pooledClientTable,
  sessionTable,
  summaryOf,
} from '../../../lib/db-sessions-view';

export default class DbSessions extends Command {
  static readonly description =
    'Show who is connected to a managed PostgreSQL and what each session is doing:\n' +
    'state, how long it has run, what it waits for, which sessions block which, and\n' +
    'the statement with its values masked. Stop one with `flui db sessions cancel`\n' +
    'or `flui db sessions terminate`, and a pooled connection with\n' +
    '`flui db sessions close-client`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-postgres',
    '<%= config.bin %> <%= command.id %> my-postgres --all',
    '<%= config.bin %> <%= command.id %> my-postgres --watch 2',
  ];

  static readonly enableJsonFlag = true;

  static readonly args = {
    db: Args.string({
      description: 'Database application name or id',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or id the database runs on',
    }),
    all: Flags.boolean({
      description: 'Include idle sessions',
      default: false,
    }),
    watch: Flags.integer({
      description: 'Refresh every N seconds until interrupted',
      min: 1,
    }),
  };

  async run(): Promise<DbSessionsView> {
    const { args, flags } = await this.parse(DbSessions);
    const client = DbSessionsClient.fromConfig();
    let view: DbSessionsView;
    try {
      const db = await client.resolveDb(args.db, flags.cluster);
      view = await client.list(db.id, flags.all);
      if (this.jsonEnabled()) return view;
      this.render(view);
      while (flags.watch) {
        await new Promise((r) => setTimeout(r, flags.watch! * 1000));
        view = await client.list(db.id, flags.all);
        process.stdout.write('\x1Bc');
        this.render(view);
      }
    } catch (e) {
      this.error(e instanceof Error ? e.message : String(e));
    }
    return view;
  }

  private render(view: DbSessionsView): void {
    this.log(chalk.cyan(summaryOf(view)));
    this.log('');
    if (!view.sessions.length) {
      this.log(
        chalk.gray(
          'No session is doing anything. Pass --all to see idle ones.',
        ),
      );
    } else {
      for (const line of sessionTable(view.sessions)) this.log(line);
    }
    if (view.truncated) {
      this.log(chalk.yellow('\nMore sessions exist than were listed.'));
    }
    if (view.pooler) this.renderPooler(view.pooler);
    this.log(chalk.gray(`\nRead at ${view.capturedAt}`));
  }

  private renderPooler(pooler: NonNullable<DbSessionsView['pooler']>): void {
    this.log(
      chalk.cyan(
        `\nPooler: ${pooler.mode} mode${pooler.paused ? ', paused' : ''}`,
      ),
    );
    for (const p of pooler.pools) {
      this.log(
        `  ${p.database}/${p.user}  clients ${p.clientsActive} active, ${p.clientsWaiting} waiting  ·  servers ${p.serversActive} active, ${p.serversIdle} idle`,
      );
    }
    if (pooler.reason) this.log(chalk.yellow(`  ${pooler.reason}`));
    if (pooler.clients.length) {
      this.log('');
      for (const line of pooledClientTable(pooler.clients)) {
        this.log(`  ${line}`);
      }
      this.log(
        chalk.gray(
          '  Close one with `flui db sessions close-client <db> <client>`.',
        ),
      );
    }
  }
}
