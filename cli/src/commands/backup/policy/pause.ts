import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupPolicyPause extends Command {
  static readonly description =
    'Pause a backup policy. Stops scheduled runs; a database-class policy keeps shipping WAL until deleted.';
  static readonly args = {
    id: Args.string({ required: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(BackupPolicyPause);
    printContextBanner();
    const spinner = ora('Pausing...').start();
    try {
      const p = await BackupClient.fromConfig().pausePolicy(args.id);
      spinner.succeed(`Paused ${args.id}`);
      if (p.status) console.log(`  ${chalk.bold('Status:')}  ${p.status}`);
      if (p.enabled !== undefined)
        console.log(`  ${chalk.bold('Enabled:')} ${p.enabled}`);
    } catch (err) {
      spinner.fail(`Pause failed: ${(err as Error).message}`);
      this.exit(1);
    }
  }
}
