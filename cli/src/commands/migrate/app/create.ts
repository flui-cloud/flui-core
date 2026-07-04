import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { MigrationClient } from '../../../lib/migration-client';
import { resolveCluster } from '../../../lib/resolve-cluster';
import { resolveApp } from '../../../lib/resolve-app';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateAppCreate extends Command {
  static readonly description =
    'Move an application workload to another cluster';
  static readonly args = {
    app: Args.string({
      description: 'Application to move (name or id)',
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
    cutover: Flags.string({
      options: ['auto', 'manual'],
      default: 'auto',
      description: 'Cutover mode',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MigrateAppCreate);
    printContextBanner();
    const target = await resolveCluster(flags.to);
    const source = await resolveCluster(flags.from);
    const app = await resolveApp(source.id, args.app);
    const spinner = ora(`Creating app migration for "${app.name}"...`).start();
    try {
      const mig = await MigrationClient.fromConfig().createAppMigration({
        srcAppId: app.id,
        targetClusterId: target.id,
        cutover: flags.cutover as 'auto' | 'manual',
      });
      spinner.succeed(`App migration created: ${mig.id}`);
      console.log('');
      console.log(`  ${chalk.bold('Status:')} ${mig.status}`);
      if (flags.cutover === 'manual') {
        console.log('');
        console.log(chalk.dim('  Cutover is manual. When ready, run:'));
        console.log(`     flui migrate app cutover ${mig.id}`);
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('App migration failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
