import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { BackupClient, BackupArtifact } from '../../lib/backup-client';
import { printContextBanner } from '../../lib/context-banner';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { formatBytes } from '../../lib/format-bytes';

interface DbPitrStatus {
  continuousBackupEnabled: boolean;
  cronSchedule: string | null;
  window: { oldest: string | null; newest: string | null } | null;
  lastBackup: { engineRef: string | null; at: string } | null;
}

interface FleetStatus {
  overall: string;
  summary: {
    clustersTotal: number;
    clustersWithBackups: number;
    clustersWithoutBackups: number;
    activePolicies: number;
    degradedPolicies: number;
    failedDestinations: number;
    failedJobsLast24h: number;
  };
  lastSuccessfulBackupAt?: string;
  alerts: Array<{ severity: string; message: string }>;
}

/**
 * The interesting cases are the gaps *between* engines — a database inside a
 * cluster policy that Velero silently skips, an application whose only copy is
 * a clone that its own deletion would remove — so every engine is answered here
 * together rather than one command at a time.
 */
export default class BackupStatus extends Command {
  static readonly description =
    'Show what is protected and how. With --app, everything protecting one ' +
    'application; without it, the whole estate.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --app my-database',
  ];

  static readonly enableJsonFlag = true;

  static readonly flags = {
    app: Flags.string({
      char: 'a',
      description: 'Application name, slug or id',
    }),
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(BackupStatus);
    if (!this.jsonEnabled()) printContextBanner();

    return flags.app ? this.forApp(flags.app, flags.cluster) : this.forFleet();
  }

  private apiClient(): ApiClient {
    const cfg = new ConfigStorage();
    const apiKey = cfg.getApiKey();
    if (!apiKey) this.error('Not logged in. Run `flui auth login` first.');
    return new ApiClient({ baseUrl: cfg.getApiUrlOrThrow(), apiKey });
  }

  private async forFleet(): Promise<unknown> {
    const api = this.apiClient();
    const status = await api.get<FleetStatus>('/backups/status');
    if (this.jsonEnabled()) return status;

    const s = status.summary;
    this.log('');
    this.log(`  ${chalk.bold('Overall:')}  ${this.severity(status.overall)}`);
    this.log('');
    this.log(
      `  Clusters protected      ${s.clustersWithBackups} of ${s.clustersTotal}`,
    );
    this.log(`  Active policies         ${s.activePolicies}`);
    if (s.degradedPolicies > 0) {
      this.log(chalk.yellow(`  Degraded policies       ${s.degradedPolicies}`));
    }
    if (s.failedDestinations > 0) {
      this.log(chalk.red(`  Unreachable destinations ${s.failedDestinations}`));
    }
    if (s.failedJobsLast24h > 0) {
      this.log(chalk.red(`  Failed runs (24h)       ${s.failedJobsLast24h}`));
    }
    this.log(
      `  Last successful backup  ${status.lastSuccessfulBackupAt?.replace('T', ' ').slice(0, 19) ?? chalk.red('never')}`,
    );

    if (status.alerts.length > 0) {
      this.log('');
      for (const alert of status.alerts) {
        this.log(`  ${this.severity(alert.severity)} ${alert.message}`);
      }
    }
    this.log('');
    this.log(chalk.dim('   flui backup status --app <name>   one application'));
    this.log('');
    return status;
  }

  private async forApp(ref: string, clusterRef?: string): Promise<unknown> {
    const { id: clusterId } = await resolveClusterRef(clusterRef);
    const appService = await CliAppService.create(clusterId);
    const app = await appService.getAppByName(ref);
    const api = this.apiClient();

    const [pitr, artifacts] = await Promise.all([
      api
        .get<DbPitrStatus>(`/applications/${app.id}/db-pitr/status`)
        .catch(() => null),
      BackupClient.fromConfig()
        .listArtifacts({ applicationId: app.id })
        .catch(() => [] as BackupArtifact[]),
    ]);

    const copies = artifacts.filter((a) => a.engineClass === 'volume_copy');
    const offCluster = copies.filter(
      (a) => a.manifestSummary?.sink === 's3-archive',
    );
    const result = { application: app.slug, pitr, copies: copies.length };
    if (!this.jsonEnabled()) {
      this.log('');
      this.log(`  ${chalk.bold(app.slug)}`);
      this.log('');

      const on = pitr?.continuousBackupEnabled;
      this.printContinuous(on, pitr);
      this.printCopies(copies);
      this.printVerdict(on, copies.length, offCluster.length);
      this.log('');
    }
    return result;
  }

  private printContinuous(on: boolean | undefined, pitr: DbPitrStatus | null) {
    this.log(
      `  ${chalk.bold('Continuous backup')}   ${
        on ? chalk.green('on') : chalk.dim('off')
      }`,
    );
    if (!on || !pitr?.window?.oldest) return;
    this.log(
      `    recoverable from    ${pitr.window.oldest.replace('T', ' ').slice(0, 19)}`,
    );
    this.log(
      `    up to               ${pitr.window.newest?.replace('T', ' ').slice(0, 19) ?? 'now'}`,
    );
  }

  private printCopies(copies: BackupArtifact[]) {
    this.log('');
    this.log(
      `  ${chalk.bold('Volume copies')}       ${copies.length === 0 ? chalk.dim('none') : copies.length}`,
    );
    for (const copy of copies.slice(0, 5)) {
      const when = (copy.createdAt ?? '').replace('T', ' ').slice(0, 16);
      const where =
        copy.manifestSummary?.sink === 's3-archive'
          ? 'object store'
          : 'in-cluster';
      const taken =
        copy.manifestSummary?.quiesce === 'writers-stopped'
          ? chalk.green('at rest')
          : chalk.yellow('live');
      const size = copy.sizeBytes ? formatBytes(Number(copy.sizeBytes)) : '—';
      this.log(`    ${when}  ${where.padEnd(13)} ${taken.padEnd(18)} ${size}`);
    }
  }

  private printVerdict(
    on: boolean | undefined,
    copies: number,
    offCluster: number,
  ) {
    this.log('');
    if (on) {
      this.log(
        chalk.green('  Protected off-cluster, with point-in-time recovery.'),
      );
      return;
    }
    if (offCluster > 0) {
      this.log(
        `  Off-cluster copies: ${offCluster}. No point-in-time recovery.`,
      );
      return;
    }
    this.log(
      chalk.red(
        '  Nothing protecting this application survives losing the cluster.',
      ),
    );
    if (copies > 0) {
      this.log(
        chalk.dim('  In-cluster clones are removed with the application.'),
      );
    }
    this.log('');
    this.log(chalk.dim('   flui backup enable database <app> -D <dest>'));
    this.log(chalk.dim('   flui app backup create <app> -D <dest>'));
  }

  private severity(value: string): string {
    if (value === 'critical' || value === 'error') return chalk.red(value);
    if (value === 'warning' || value === 'degraded') return chalk.yellow(value);
    return chalk.green(value);
  }
}
