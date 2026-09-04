import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupRestoreShow extends Command {
  static readonly description = 'Show a restore job by ID';
  static readonly args = { id: Args.string({ required: true }) };
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupRestoreShow);
    printContextBanner();
    const client = BackupClient.fromConfig();
    const r = await client.getRestore(args.id);
    if (flags.json) {
      this.log(JSON.stringify(r, null, 2));
      return;
    }
    this.log('');
    this.log(`   ${chalk.bold('ID:')}         ${r.id}`);
    this.log(`   ${chalk.bold('Status:')}     ${r.status}`);
    this.log(`   ${chalk.bold('Artifact:')}   ${r.artifactId}`);
    this.log(`   ${chalk.bold('Source:')}     ${r.sourceDestinationId}`);
    this.log(
      `   ${chalk.bold('Target:')}     ${r.targetKind} → cluster=${r.targetClusterId}`,
    );
    let placement = chalk.dim('not recorded (restore predates this field)');
    if (r.placement === 'existing') {
      placement = chalk.yellow(
        'existing — replaced the objects in place, volumes kept',
      );
    } else if (r.placement === 'new') {
      placement = 'new — restored beside the original';
    }
    this.log(`   ${chalk.bold('Placement:')}  ${placement}`);
    if (r.strategy) this.log(`   ${chalk.bold('Strategy:')}   ${r.strategy}`);
    if (r.startedAt) this.log(`   ${chalk.bold('Started:')}    ${r.startedAt}`);
    if (r.completedAt)
      this.log(`   ${chalk.bold('Completed:')}  ${r.completedAt}`);
    if (r.errorMessage)
      this.log(chalk.red(`   ${chalk.bold('Error:')}      ${r.errorMessage}`));
    this.log('');
  }
}
