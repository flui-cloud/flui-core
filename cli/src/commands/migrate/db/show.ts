import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { MigrationClient } from '../../../lib/migration-client';
import { printContextBanner } from '../../../lib/context-banner';
import { labelCell, measureRows } from '../../../lib/migration-measures-view';

export default class MigrateDbShow extends Command {
  static readonly description = 'Show a managed-Postgres migration by id';
  static readonly args = {
    id: Args.string({ required: true, description: 'Migration id' }),
  };
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MigrateDbShow);
    printContextBanner();
    const m = await MigrationClient.fromConfig().getDbMigration(args.id);
    if (flags.json) {
      this.log(JSON.stringify(m, null, 2));
      return;
    }
    this.log('');
    this.log(`   ${chalk.bold('ID:')}         ${m.id}`);
    this.log(`   ${chalk.bold('Status:')}     ${m.status}`);
    this.log(`   ${chalk.bold('Source app:')} ${m.srcAppId}`);
    if (m.dstAppId) this.log(`   ${chalk.bold('Dest app:')}   ${m.dstAppId}`);
    this.log(`   ${chalk.bold('Target:')}     ${m.targetClusterId}`);
    if (m.mode) this.log(`   ${chalk.bold('Mode:')}       ${m.mode}`);
    this.log(`   ${chalk.bold('Cutover:')}    ${m.cutoverMode}`);
    for (const [label, value] of measureRows(m)) {
      this.log(`   ${chalk.bold(labelCell(label))}${value}`);
    }
    if (m.errorMessage)
      this.log(`   ${chalk.bold('Error:')}      ${chalk.red(m.errorMessage)}`);
    if (m.createdAt) this.log(`   ${chalk.bold('Created:')}    ${m.createdAt}`);
    if (m.finishedAt)
      this.log(`   ${chalk.bold('Finished:')}   ${m.finishedAt}`);
    this.log('');
  }
}
