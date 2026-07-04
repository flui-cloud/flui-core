import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { MigrationClient } from '../../../lib/migration-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateFullShow extends Command {
  static readonly description = 'Show a full-app migration by id';
  static readonly args = {
    id: Args.string({ required: true, description: 'Migration id' }),
  };
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MigrateFullShow);
    printContextBanner();
    const m = await MigrationClient.fromConfig().getFullMigration(args.id);
    if (flags.json) {
      this.log(JSON.stringify(m, null, 2));
      return;
    }
    this.log('');
    this.log(`   ${chalk.bold('ID:')}         ${m.id}`);
    this.log(`   ${chalk.bold('Status:')}     ${m.status}`);
    this.log(`   ${chalk.bold('App:')}        ${m.appId}`);
    this.log(`   ${chalk.bold('DB app:')}     ${m.dbAppId}`);
    this.log(`   ${chalk.bold('Target:')}     ${m.targetClusterId}`);
    this.log(`   ${chalk.bold('Cutover:')}    ${m.cutoverMode}`);
    this.log(`   ${chalk.bold('Staging:')}    ${m.stagingMode}`);
    if (m.dbMigrationId)
      this.log(`   ${chalk.bold('DB leg:')}     ${m.dbMigrationId}`);
    if (m.appMigrationId)
      this.log(`   ${chalk.bold('App leg:')}    ${m.appMigrationId}`);
    if (m.errorMessage)
      this.log(`   ${chalk.bold('Error:')}      ${chalk.red(m.errorMessage)}`);
    if (m.createdAt) this.log(`   ${chalk.bold('Created:')}    ${m.createdAt}`);
    if (m.finishedAt)
      this.log(`   ${chalk.bold('Finished:')}   ${m.finishedAt}`);
    this.log('');
  }
}
