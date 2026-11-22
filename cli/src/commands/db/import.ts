import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveAppOnAnyCluster } from '../../lib/resolve-app';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { promptMaskedInput } from '../../lib/prompts';
import { DbImportView, importLines } from '../../lib/db-import-view';

const PASSWORD_ENV = 'FLUI_IMPORT_SOURCE_PASSWORD';

export default class DbImport extends Command {
  static readonly description =
    'Copy an external database into an empty Flui database of the same engine,\n' +
    'keep it in step, then switch over.\n' +
    'PostgreSQL: the source needs wal_level=logical and a user that can replicate\n' +
    '(a superuser, or rds_superuser on RDS); Flui adds there only a publication, a\n' +
    'replication slot and, on tables without a primary key, a full replica\n' +
    'identity, all removed at the end.\n' +
    'MariaDB: the source needs binary logging in ROW format and a user with\n' +
    'REPLICATION SLAVE, BINLOG MONITOR and RELOAD; Flui adds nothing there.\n' +
    `The password is asked for, or read from ${PASSWORD_ENV}; it is never a flag.`;

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> postgresql-051f58 --host db.example.com --database shop --user replicator',
    '<%= config.bin %> <%= command.id %> postgresql-051f58',
    '<%= config.bin %> <%= command.id %> postgresql-051f58 --switch',
    '<%= config.bin %> <%= command.id %> postgresql-051f58 --cancel',
  ];

  static readonly args = {
    app: Args.string({
      description:
        'Flui PostgreSQL or MariaDB to import into: name, slug or id',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or id (default: look the name up everywhere)',
    }),
    host: Flags.string({ description: 'Source host name or IP address' }),
    port: Flags.integer({
      description:
        'Source port (default 5432 for PostgreSQL, 3306 for MariaDB)',
    }),
    database: Flags.string({ description: 'Source database' }),
    user: Flags.string({ description: 'Source user, able to replicate' }),
    sslmode: Flags.string({
      options: ['disable', 'prefer', 'require', 'verify-full'],
      default: 'require',
      description: 'TLS towards the source',
    }),
    switch: Flags.boolean({
      default: false,
      description:
        'Finish: wait for the last changes, align sequences, detach from the source. Stop writes to the source first.',
      exclusive: ['cancel', 'host'],
    }),
    cancel: Flags.boolean({
      default: false,
      description: 'Stop the import; what was copied stays',
      exclusive: ['switch', 'host'],
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbImport);
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    const clusterId = flags.cluster
      ? (await resolveClusterRef(flags.cluster)).id
      : undefined;
    const app = await resolveAppOnAnyCluster(args.app, clusterId);
    const path = `/applications/${app.id}/import`;

    let view: DbImportView | null;
    if (flags.host) {
      if (!flags.database || !flags.user) {
        this.error('--host needs --database and --user too');
      }
      const password =
        process.env[PASSWORD_ENV] ??
        (await promptMaskedInput(`Password of ${flags.user} on the source: `));
      view = await api.post<DbImportView>(path, {
        source: {
          host: flags.host,
          port: flags.port ?? (await this.defaultPort(api, app.id)),
          database: flags.database,
          user: flags.user,
          sslmode: flags.sslmode,
        },
        password,
      });
    } else if (flags.switch) {
      view = await api.post<DbImportView>(`${path}/cutover`, {});
    } else if (flags.cancel) {
      view = await api.delete<DbImportView>(path);
    } else {
      view = await api.get<DbImportView | null>(path);
    }

    if (flags.json) {
      this.log(JSON.stringify(view, null, 2));
      return;
    }
    this.log('');
    if (!view) {
      this.log(
        `   ${chalk.bold(app.name)}: nothing was ever imported into it.`,
      );
      this.log('');
      return;
    }
    this.log(`   ${chalk.bold(app.name)}`);
    for (const line of importLines(view, args.app)) this.log(line);
    if (flags.host || flags.switch || flags.cancel) {
      this.log(chalk.dim(`\n   Follow it with: flui db import ${args.app}`));
    }
    this.log('');
  }

  private async defaultPort(api: ApiClient, appId: string): Promise<number> {
    const env = await api
      .get<{ env?: Array<{ name: string }> }>(`/applications/${appId}`)
      .then((a) => a.env ?? [])
      .catch(() => []);
    return env.some((e) => e.name === 'MARIADB_ROOT_PASSWORD') ? 3306 : 5432;
  }
}
