import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { MigrationClient } from '../../../lib/migration-client';
import { resolveCluster } from '../../../lib/resolve-cluster';
import { resolveApp } from '../../../lib/resolve-app';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateDbCreate extends Command {
  static readonly description =
    'Move a managed-Postgres app to another cluster';
  static readonly args = {
    dbapp: Args.string({
      description: 'Managed-Postgres app to move',
      required: true,
    }),
  };
  static readonly flags = {
    to: Flags.string({
      char: 't',
      required: true,
      description: 'Target cluster name or id',
    }),
    from: Flags.string({
      char: 'f',
      description: 'Source cluster name or id (default: auto-detect)',
    }),
    mode: Flags.string({
      options: ['live', 'restore'],
      default: 'live',
      description: 'Migration mode',
    }),
    cutover: Flags.string({
      options: ['auto', 'manual'],
      default: 'auto',
      description: 'Cutover mode',
    }),
    at: Flags.string({
      description: 'restore mode only: ISO-8601 instant to recover to',
    }),
    name: Flags.string({
      description: 'display name for the new install',
    }),
    verify: Flags.boolean({
      allowNo: true,
      default: true,
      description: 'exact per-table count(*) comparison at cutover',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MigrateDbCreate);
    printContextBanner();
    const target = await resolveCluster(flags.to);
    const source = await resolveCluster(flags.from);
    const app = await resolveApp(source.id, args.dbapp);
    const spinner = ora(`Creating DB migration for "${app.name}"...`).start();
    try {
      const mig = await MigrationClient.fromConfig().createDbMigration({
        srcAppId: app.id,
        targetClusterId: target.id,
        mode: flags.mode as 'live' | 'restore',
        cutover: flags.cutover as 'auto' | 'manual',
        recoveryTargetTime: flags.at,
        displayName: flags.name,
        verifyRowCounts: flags.verify,
      });
      spinner.succeed(`DB migration created: ${mig.id}`);
      console.log('');
      console.log(`  ${chalk.bold('Status:')} ${mig.status}`);
      if (flags.cutover === 'manual') {
        console.log('');
        console.log(chalk.dim('  Cutover is manual. When ready, run:'));
        console.log(`     flui migrate db cutover ${mig.id}`);
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('DB migration failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
