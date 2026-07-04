import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { MigrationClient } from '../../../lib/migration-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class MigrateDbList extends Command {
  static readonly description = 'List managed-Postgres migrations';
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateDbList);
    printContextBanner();
    const items = await MigrationClient.fromConfig().listDbMigrations();
    if (flags.json) {
      this.log(JSON.stringify(items, null, 2));
      return;
    }
    if (items.length === 0) {
      this.log(chalk.yellow('\n   No DB migrations.\n'));
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
