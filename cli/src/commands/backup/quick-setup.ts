import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient } from '../../lib/backup-client';
import { printContextBanner } from '../../lib/context-banner';
import { resolveClusterRef } from '../../lib/resolve-cluster';

/**
 * The one-click setup, reachable from a terminal.
 *
 * It asks for no secret: the bucket is provisioned with the provider
 * credential this installation already holds, which is why it never needed to
 * be a dashboard-only button.
 */
export default class BackupQuickSetup extends Command {
  static readonly description =
    'Provision backup storage and protect a cluster in one step, using the provider already connected';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --cluster workload-cluster-2',
    '<%= config.bin %> <%= command.id %> --schedule "0 3 * * *" --retention-days 14',
  ];

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    'dry-run': Flags.boolean({
      description: 'Only report what would be set up, and whether it can be',
      default: false,
    }),
    schedule: Flags.string({
      description: 'Cron schedule for the recurring backup',
    }),
    'retention-days': Flags.integer({ min: 1 }),
    'no-first-backup': Flags.boolean({
      description: 'Do not run the first backup immediately',
      default: false,
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupQuickSetup);
    printContextBanner();

    const { id: clusterId, name } = await resolveClusterRef(flags.cluster);
    const client = BackupClient.fromConfig();

    const options = await client.getSetupOptions(clusterId);
    if (flags.json && flags['dry-run']) {
      this.log(JSON.stringify(options, null, 2));
      return;
    }

    this.log('');
    this.log(`  Cluster    ${chalk.bold(name)}`);
    this.log(`  Storage    ${options.primary.provider}`);

    if (!options.primary.ready) {
      // Not an error: the answer to "can this be set up" is no, and the reason
      // is the thing to act on.
      this.log(
        `  Ready      ${chalk.yellow('no')} — ${options.primary.reason}`,
      );
      if (options.primary.needsScalewayConnection) {
        this.log('');
        this.log(
          chalk.dim(
            '  Connect the provider that will hold the backups, then run this again.',
          ),
        );
      }
      this.log('');
      this.exit(1);
    }

    this.log(`  Ready      ${chalk.green('yes')}`);

    if (flags['dry-run']) {
      this.log('');
      this.log(
        chalk.dim(
          '  Would provision a bucket, register it as a destination, and protect this cluster.',
        ),
      );
      this.log('');
      return;
    }

    const result = await client.startQuickSetup(clusterId, {
      profile: 'single',
      cronSchedule: flags.schedule,
      retentionDays: flags['retention-days'],
      runFirstBackup: !flags['no-first-backup'],
    });

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2));
      return;
    }

    this.log('');
    this.log(
      chalk.green('  Backup storage provisioned and the cluster protected.'),
    );
    if (result.operationId) {
      this.log(
        chalk.dim(
          `  Track it with: flui env logs --operation ${result.operationId}`,
        ),
      );
    }
    this.log(chalk.dim('  See what it covers: flui backup status'));
    this.log('');
  }
}
