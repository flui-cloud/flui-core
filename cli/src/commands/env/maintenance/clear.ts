import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { CliAppService } from '../../../lib/services/cli-app.service';

export default class EnvMaintenanceClear extends Command {
  static readonly description =
    "Remove a cluster's maintenance window. Changes already held keep their time; new ones can only be applied at once.";

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvMaintenanceClear);
    const cluster = await resolveClusterRef(flags.cluster);
    const service = await CliAppService.create(cluster.id);
    const written = await service.clearClusterMaintenance(cluster.id);
    this.log(`\n  ${chalk.green('✔')} ${cluster.name}: ${written.says}\n`);
  }
}
