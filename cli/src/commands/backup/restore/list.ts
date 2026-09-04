import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

function placementLabel(placement?: string): string {
  if (placement === 'existing') return chalk.yellow('replaced-in-place');
  if (placement === 'new') return 'beside-original';
  return chalk.dim('placement-unrecorded');
}

export default class BackupRestoreList extends Command {
  static readonly description = 'List restore jobs';
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupRestoreList);
    printContextBanner();
    const client = BackupClient.fromConfig();
    const items = await client.listRestores();
    if (flags.json) {
      this.log(JSON.stringify(items, null, 2));
      return;
    }
    if (items.length === 0) {
      this.log(chalk.yellow('\n   No restore jobs.\n'));
      return;
    }
    this.log('');
    for (const r of items) {
      this.log(
        `   ${chalk.cyan(r.id)}  ${r.status}  kind=${r.targetKind}  ` +
          `${placementLabel(r.placement)}  cluster=${r.targetClusterId}`,
      );
    }
    this.log('');
  }
}
