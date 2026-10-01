import { Command } from '@oclif/core';
import chalk from 'chalk';

/**
 * Kept hidden so an old script gets directions instead of "command not found":
 * each kind of restore has its own command.
 */
export default class BackupRestoreCreate extends Command {
  static readonly hidden = true;
  static readonly description =
    'Replaced by `flui db pitr-restore` and `flui app backup restore`.';

  static readonly strict = false;

  async run(): Promise<void> {
    this.log('');
    this.log(chalk.yellow('  `flui backup restore create` has been replaced.'));
    this.log('');
    this.log(
      `    ${chalk.bold('flui db pitr-restore')}       ${chalk.dim('a database, into a new one (optionally as of a moment)')}`,
    );
    this.log(
      `    ${chalk.bold('flui app backup restore')}    ${chalk.dim("an application's volume, whole or single files")}`,
    );
    this.log(
      `    ${chalk.bold('flui cluster rebuild')}       ${chalk.dim('every application of a lost cluster onto a new one')}`,
    );
    this.log('');
    this.exit(1);
  }
}
