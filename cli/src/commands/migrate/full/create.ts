import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { MigrationClient } from '../../../lib/migration-client';
import { resolveCluster } from '../../../lib/resolve-cluster';
import { resolveApp } from '../../../lib/resolve-app';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateFullCreate extends Command {
  static readonly description =
    'Move a consumer app together with its managed-Postgres data';
  static readonly args = {
    app: Args.string({
      description: 'Consumer application to move',
      required: true,
    }),
  };
  static readonly flags = {
    db: Flags.string({
      required: true,
      description:
        'Managed-Postgres app (name or id) whose data migrates with the app',
    }),
    to: Flags.string({
      char: 't',
      required: true,
      description: 'Target cluster name or id',
    }),
    from: Flags.string({
      char: 'f',
      description: 'Source cluster name or id (default: auto-detect)',
    }),
    cutover: Flags.string({
      options: ['auto', 'manual'],
      default: 'auto',
      description: 'Cutover mode',
    }),
    staging: Flags.string({
      options: ['scaled-down', 'live-fenced'],
      default: 'scaled-down',
      description: 'Staging mode for the destination app before cutover',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MigrateFullCreate);
    printContextBanner();
    const target = await resolveCluster(flags.to);
    const source = await resolveCluster(flags.from);
    const app = await resolveApp(source.id, args.app);
    const db = await resolveApp(source.id, flags.db);
    const spinner = ora(`Creating full migration for "${app.name}"...`).start();
    try {
      const mig = await MigrationClient.fromConfig().createFullMigration({
        appId: app.id,
        dbAppId: db.id,
        targetClusterId: target.id,
        cutover: flags.cutover as 'auto' | 'manual',
        stagingMode: flags.staging as 'scaled-down' | 'live-fenced',
      });
      spinner.succeed(`Full migration created: ${mig.id}`);
      console.log('');
      console.log(`  ${chalk.bold('Status:')} ${mig.status}`);
      if (flags.staging === 'live-fenced') {
        console.log('');
        console.log(
          chalk.yellow(
            'live-fenced: the app is staged at full replicas against a READ-ONLY destination DB — it must boot with no write-migrations-on-start and must not run background workers/schedulers with external side-effects (queue consumers, cron, outbound webhooks/email) until cutover.',
          ),
        );
      }
      if (flags.cutover === 'manual') {
        console.log('');
        console.log(chalk.dim('  Cutover is manual. When ready, run:'));
        console.log(`     flui migrate full cutover ${mig.id}`);
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Full migration failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
