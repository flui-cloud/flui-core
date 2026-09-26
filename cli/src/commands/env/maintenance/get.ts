import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { printDeferred, printOpening } from '../../../lib/maintenance-view';

export default class EnvMaintenanceGet extends Command {
  static readonly description =
    "A cluster's maintenance window, when it next opens, and the changes held for it";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --cluster production',
  ];

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvMaintenanceGet);
    const cluster = await resolveClusterRef(flags.cluster);
    const service = await CliAppService.create(cluster.id);
    const [window, held] = await Promise.all([
      service.clusterMaintenance(cluster.id),
      service.clusterDeferredActions(cluster.id),
    ]);
    if (flags.json) {
      this.log(JSON.stringify({ ...window, deferred: held }, null, 2));
      return;
    }
    this.log('');
    this.log(`  ${chalk.bold(cluster.name)}  ${window.says}`);
    printOpening(window.nextOpening);
    printDeferred(held);
    this.log('');
  }
}
