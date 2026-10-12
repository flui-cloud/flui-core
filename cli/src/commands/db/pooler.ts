import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveAppOnAnyCluster } from '../../lib/resolve-app';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { DbPoolerStatus, poolerLines } from '../../lib/db-pooler-view';

export default class DbPooler extends Command {
  static readonly description =
    'Show the connection pooler of a managed PostgreSQL: its mode, whether\n' +
    'FLUI_CONNECTION_URL goes through it, and the two in-cluster addresses\n' +
    '(pooled for apps, direct for migrations, LISTEN and admin tools).\n' +
    'The pooler is chosen at install: flui catalog install postgresql --option pooler=false';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> postgresql-051f58',
    '<%= config.bin %> <%= command.id %> postgresql-051f58 --json',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Database application name, slug, or id',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or id (default: look the name up everywhere)',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbPooler);
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    const clusterId = flags.cluster
      ? (await resolveClusterRef(flags.cluster)).id
      : undefined;
    const app = await resolveAppOnAnyCluster(args.app, clusterId);
    const status = await api.get<DbPoolerStatus>(
      `/applications/${app.id}/db/pooler`,
    );
    if (flags.json) {
      this.log(JSON.stringify(status, null, 2));
      return;
    }
    this.log('');
    this.log(`   ${chalk.bold(app.name)}`);
    for (const line of poolerLines(status)) this.log(`   ${line}`);
    this.log('');
  }
}
