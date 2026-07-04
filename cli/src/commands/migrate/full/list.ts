import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { MigrationClient } from '../../../lib/migration-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateFullList extends Command {
  static readonly description = 'List full-app migrations';
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateFullList);
    printContextBanner();
    const items = await MigrationClient.fromConfig().listFullMigrations();
    if (flags.json) {
      this.log(JSON.stringify(items, null, 2));
      return;
    }
    if (items.length === 0) {
      this.log(chalk.yellow('\n   No full migrations.\n'));
      return;
    }
    this.log('');
    for (const m of items) {
      this.log(
        `   ${chalk.cyan(m.id)}  ${m.status}  → ${m.targetClusterId}  (${m.cutoverMode})`,
      );
    }
    this.log('');
  }
}
