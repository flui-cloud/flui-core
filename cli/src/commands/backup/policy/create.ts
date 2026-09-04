import { Command } from '@oclif/core';
import chalk from 'chalk';

/**
 * A tombstone that maps the retired command onto the `enable` verbs. The
 * low-level escape hatch is the API, which has not changed.
 */
export default class BackupPolicyCreate extends Command {
  static readonly hidden = true;
  static readonly description =
    'Replaced by `flui backup enable cluster|database|platform`.';

  // Everything is accepted so the old invocation reaches the mapping below
  // instead of failing on an unknown flag before it can be explained.
  static readonly strict = false;

  async run(): Promise<void> {
    this.log('');
    this.log(chalk.yellow('  `flui backup policy create` has been replaced.'));
    this.log('');
    this.log('  What you probably want:');
    this.log('');
    this.log(
      `    ${chalk.bold('flui backup enable cluster')}    ${chalk.dim('was --engine-class volume')}`,
    );
    this.log(
      `    ${chalk.bold('flui backup enable database')}   ${chalk.dim('was --engine-class database')}`,
    );
    this.log(
      `    ${chalk.bold('flui backup enable platform')}   ${chalk.dim('was --engine-class platform')}`,
    );
    this.log('');
    this.log(
      chalk.dim(
        '  Scope is no longer a separate flag: `enable cluster --namespaces a,b`\n' +
          '  narrows, and omitting it protects the whole cluster.\n',
      ),
    );
    this.log(
      chalk.dim(
        '  `flui backup policy list|show|pause|resume|delete` are unchanged.\n',
      ),
    );
    this.exit(1);
  }
}
