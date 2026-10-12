import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { MigrationClient } from '../../../lib/migration-client';
import { confirmPrompt } from '../../../lib/prompts';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateDbAbort extends Command {
  static readonly description =
    'Abort a DB migration before the destination is promoted (replication torn down, destination install kept for inspection). A physical migration can also be aborted in cutover until promote has been asked; Flui then removes exactly its own fence from the source. Once promote has been asked the migration only goes forward.';
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
          `Abort DB migration ${args.id}? Replication is torn down and the destination install stays for inspection (remove it like any application). A physical migration in cutover is aborted only until promote has been asked: the source's fence block is removed and it takes writes again (other edits made meanwhile are kept). After that it only goes forward.`,
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
