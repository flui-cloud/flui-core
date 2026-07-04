import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { MigrationClient } from '../../../lib/migration-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateAppList extends Command {
  static readonly description = 'List app-workload migrations';
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateAppList);
    printContextBanner();
    const items = await MigrationClient.fromConfig().listAppMigrations();
    if (flags.json) {
      this.log(JSON.stringify(items, null, 2));
      return;
    }
    if (items.length === 0) {
      this.log(chalk.yellow('\n   No app migrations.\n'));
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
