import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { MigrationClient } from '../../../lib/migration-client';
import { confirmPrompt } from '../../../lib/prompts';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateFullDestroySource extends Command {
  static readonly description =
    'Close the bridge and destroy the source app workload after cutover (irreversible)';
  static readonly args = {
    id: Args.string({ required: true, description: 'Migration id' }),
  };
  static readonly flags = {
    yes: Flags.boolean({ char: 'y', default: false }),
    'close-bridge': Flags.boolean({
      default: false,
      description:
        'Close an open bridge now, even if DNS answers cached before the switch may still point at the old cluster',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MigrateFullDestroySource);
    printContextBanner();
    if (!flags.yes) {
      const ok = await confirmPrompt(
        chalk.yellow(
          `Destroy the SOURCE app workload for ${args.id}${
            flags['close-bridge'] ? ' and close its bridge now' : ''
          }? Irreversible.`,
        ),
        false,
      );
      if (!ok) {
        this.log(chalk.green('Cancelled'));
        return;
      }
    }
    const spinner = ora('Destroying source...').start();
    try {
      const mig = await MigrationClient.fromConfig().destroyFullMigrationSource(
        args.id,
        { closeBridge: flags['close-bridge'] },
      );
      spinner.succeed(`Source destroyed for ${args.id}`);
      console.log(`  ${chalk.bold('Status:')} ${mig.status}`);
    } catch (error: any) {
      spinner.fail('Destroy failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
