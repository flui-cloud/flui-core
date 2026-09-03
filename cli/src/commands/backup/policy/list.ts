import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupPolicyList extends Command {
  static readonly description = 'List backup policies';
  static readonly flags = {
    cluster: Flags.string({ description: 'Filter by cluster ID' }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupPolicyList);
    printContextBanner();
    const client = BackupClient.fromConfig();
    const items = flags.cluster
      ? await client.listPoliciesForCluster(flags.cluster)
      : await client.listPolicies();
    if (flags.json) {
      this.log(JSON.stringify(items, null, 2));
      return;
    }
    if (items.length === 0) {
      this.log(chalk.yellow('\n   No backup policies.\n'));
      return;
    }
    this.log('');
    for (const p of items) {
      this.log(
        `   ${chalk.cyan(p.id)}  ${chalk.bold(p.name)}  ${p.engineClass ?? 'volume'}/${p.profile}/${p.scope}  cluster=${p.clusterId}` +
          (p.cronSchedule ? ` cron=${p.cronSchedule}` : '') +
          (p.enabled === false ? chalk.dim(' [disabled]') : ''),
      );
    }
    this.log('');
  }
}
