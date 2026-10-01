import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';
import { resolveClusterRef } from '../../../lib/resolve-cluster';

export default class BackupDisableCluster extends Command {
  static readonly description =
    'Stop protecting new applications on a cluster. The policies already ' +
    'created keep running; remove one with `flui backup policy delete`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --cluster workload-cluster-2',
  ];

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupDisableCluster);
    printContextBanner();
    const { id: clusterId, name } = await resolveClusterRef(flags.cluster);
    try {
      const { stopped } =
        await BackupClient.fromConfig().stopClusterProtection(clusterId);
      console.log('');
      console.log(
        stopped
          ? `  ${chalk.green('✓')} Applications installed on ${name} from now on get no backup policy automatically.`
          : chalk.dim(`  ${name} was not protected automatically.`),
      );
      if (stopped) {
        console.log(
          chalk.dim('    The policies already created keep running.'),
        );
      }
      console.log('');
    } catch (error: any) {
      const msg = error.details?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  ${msg}\n`));
      this.exit(1);
    }
  }
}
