import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { MigrationClient } from '../../../lib/migration-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateFullCutover extends Command {
  static readonly description =
    'Fire the cutover for a parked (manual) full migration';
  static readonly args = {
    id: Args.string({ required: true, description: 'Migration id' }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(MigrateFullCutover);
    printContextBanner();
    const spinner = ora(`Cutting over ${args.id}...`).start();
    try {
      const mig = await MigrationClient.fromConfig().cutoverFullMigration(
        args.id,
      );
      spinner.succeed(`Cutover started: ${mig.id}`);
      console.log(`  ${chalk.bold('Status:')} ${mig.status}`);
    } catch (error: any) {
      spinner.fail('Cutover failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
