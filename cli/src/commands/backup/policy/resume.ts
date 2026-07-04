import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupPolicyResume extends Command {
  static readonly description = 'Resume a paused backup policy';
  static readonly args = {
    id: Args.string({ required: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(BackupPolicyResume);
    printContextBanner();
    const spinner = ora('Resuming...').start();
    try {
      const p = await BackupClient.fromConfig().resumePolicy(args.id);
      spinner.succeed(`Resumed ${args.id}`);
      if (p.status) console.log(`  ${chalk.bold('Status:')}  ${p.status}`);
      if (p.enabled !== undefined)
        console.log(`  ${chalk.bold('Enabled:')} ${p.enabled}`);
    } catch (err) {
      spinner.fail(`Resume failed: ${(err as Error).message}`);
      this.exit(1);
    }
  }
}
