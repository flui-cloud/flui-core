import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupJobShow extends Command {
  static readonly description = 'Show a backup job by ID';
  static readonly args = { id: Args.string({ required: true }) };
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupJobShow);
    printContextBanner();
    const client = BackupClient.fromConfig();
    const j = await client.getJob(args.id);
    if (flags.json) {
      this.log(JSON.stringify(j, null, 2));
      return;
    }
    this.log('');
    this.log(`   ${chalk.bold('ID:')}        ${j.id}`);
    this.log(`   ${chalk.bold('Policy:')}    ${j.policyId}`);
    this.log(`   ${chalk.bold('Status:')}    ${j.status}`);
    if (j.startedAt) this.log(`   ${chalk.bold('Started:')}   ${j.startedAt}`);
    if (j.completedAt)
      this.log(`   ${chalk.bold('Completed:')} ${j.completedAt}`);
    if (j.bytesTransferred)
      this.log(
        `   ${chalk.bold('Bytes:')}     ${(j.bytesTransferred / 1024 ** 2).toFixed(2)} MB`,
      );
    const stopped = Object.entries(j.metadata?.stoppedSeconds ?? {});
    for (const [volume, seconds] of stopped) {
      const copying = chalk.dim('while copying ' + volume);
      this.log(`   ${chalk.bold('Stopped:')}   ${seconds}s ${copying}`);
    }
    if (j.errorMessage)
      this.log(chalk.red(`   ${chalk.bold('Error:')}     ${j.errorMessage}`));
    this.log('');
  }
}
