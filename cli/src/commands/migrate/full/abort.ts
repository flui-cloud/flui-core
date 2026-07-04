import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { MigrationClient } from '../../../lib/migration-client';
import { confirmPrompt } from '../../../lib/prompts';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateFullAbort extends Command {
  static readonly description =
    'Abort a full migration before cutover (both legs torn down, source untouched)';
  static readonly args = {
    id: Args.string({ required: true, description: 'Migration id' }),
  };
  static readonly flags = {
    yes: Flags.boolean({ char: 'y', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MigrateFullAbort);
    printContextBanner();
    if (!flags.yes) {
      const ok = await confirmPrompt(
        chalk.yellow(
          `Abort full migration ${args.id}? Both legs are torn down; the source is untouched. (Refused once the DB has promoted.)`,
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
      const mig = await MigrationClient.fromConfig().abortFullMigration(
        args.id,
      );
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
