import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { BackupClient, ProtectedApp } from '../../lib/backup-client';
import { followOperation } from '../../lib/follow-operation';
import {
  describeProtectedApp,
  printNeedsDecision,
} from '../../lib/cluster-protection-format';
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
    'Provision backup storage and protect every application on a cluster in one step, using the provider already connected. ' +
    'Each application gets a policy of its own with the engine that fits it, and so does every application installed later.';

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
      description:
        'One cron schedule in UTC for every policy. Omit it to use the default of each kind of backup, spread across the night.',
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
          '  Would provision a bucket, register it as a destination, and give every application on this cluster a backup policy.',
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
    if (!result.operationId) {
      this.log(
        chalk.green('  Backup storage provisioned and the cluster protected.'),
      );
      this.log('');
      return;
    }
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    const printed = new Set<string>();
    const op = await followOperation<{ apps?: ProtectedApp[] }>(
      api,
      result.operationId,
      {
        intervalMs: 3000,
        onUpdate: (current) => {
          for (const app of current.metadata?.apps ?? []) {
            if (printed.has(app.applicationId)) continue;
            printed.add(app.applicationId);
            this.log(describeProtectedApp(app));
          }
        },
      },
    );
    this.log('');
    if (op?.status !== 'COMPLETED') {
      const stillRunning = `Still running — follow it with: flui operation ${result.operationId} --follow`;
      this.log(chalk.red(`  ${op?.errorMessage ?? stillRunning}`));
      this.log('');
      if (op) this.exit(1);
      return;
    }
    this.log(
      chalk.green(
        '  Backup storage provisioned and every application protected, including the ones installed later.',
      ),
    );
    const protection = await client
      .getClusterProtection(clusterId)
      .catch(() => null);
    printNeedsDecision(protection?.needsDecision ?? []);
    this.log(chalk.dim('  See what it covers: flui backup status'));
    this.log('');
  }
}
