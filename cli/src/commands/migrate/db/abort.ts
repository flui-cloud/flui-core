import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { MigrationClient } from '../../../lib/migration-client';
import { confirmPrompt } from '../../../lib/prompts';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateDbAbort extends Command {
  static readonly description =
    'Abort a DB migration before cutover (replication link + destination torn down, source untouched)';
  static readonly args = {
    id: Args.string({ required: true, description: 'Migration id' }),
  };
  static readonly flags = {
    yes: Flags.boolean({ char: 'y', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MigrateDbAbort);
    printContextBanner();
    if (!flags.yes) {
      const ok = await confirmPrompt(
        chalk.yellow(
          `Abort DB migration ${args.id}? The replication link + destination install are torn down; the source is untouched.`,
        ),
        false,
      );
      if (!ok) {
        this.log(chalk.green('Cancelled'));
        return;
      }
    }
    const spinner = ora('Aborting...').start();
    try {
      const mig = await MigrationClient.fromConfig().abortDbMigration(args.id);
      spinner.succeed(`Aborted ${args.id}`);
      console.log(`  ${chalk.bold('Status:')} ${mig.status}`);
    } catch (error: any) {
      spinner.fail('Abort failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
