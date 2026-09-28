import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { confirmPrompt } from '../../../lib/prompts';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupPolicyDelete extends Command {
  static readonly description =
    'Delete a backup policy (existing artifacts are retained)';
  static readonly args = {
    id: Args.string({ required: true }),
  };
  static readonly flags = {
    yes: Flags.boolean({
      char: 'y',
      default: false,
      aliases: ['force'],
      charAliases: ['f'],
      description: 'Skip confirmation (also --force, -f)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupPolicyDelete);
    printContextBanner();
    const client = BackupClient.fromConfig();
    if (!flags.yes) {
      const ok = await confirmPrompt(
        chalk.yellow(`Delete policy ${args.id}? Existing backups are kept.`),
        false,
      );
      if (!ok) {
        this.log(chalk.green('Cancelled'));
        return;
      }
    }
    const spinner = ora('Deleting...').start();
    try {
      await client.deletePolicy(args.id);
      spinner.succeed(`Deleted ${args.id}`);
    } catch (err) {
      spinner.fail(`Delete failed: ${(err as Error).message}`);
      this.exit(1);
    }
  }
}
