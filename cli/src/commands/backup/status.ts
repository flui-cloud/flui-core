import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import {
  BackupClient,
  BackupArtifact,
  NeedsDecisionItem,
} from '../../lib/backup-client';
import { printContextBanner } from '../../lib/context-banner';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { formatBytes } from '../../lib/format-bytes';
import { printNeedsDecision } from '../../lib/cluster-protection-format';
import {
  AlertItem,
  DecidedApp,
  alertItemLines,
  coverageAppLabel,
  coverageAppReason,
  decisionLine,
} from '../../lib/backup-status-format';

interface DbPitrStatus {
  continuousBackupEnabled: boolean;
  pointInTime?: boolean;
  backupCount?: number;
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
  alerts: Array<{ severity: string; message: string; items?: AlertItem[] }>;
  clusters?: Array<{
    clusterId: string;
    name: string;
    protected: boolean;
    needsDecision: NeedsDecisionItem[];
    pending?: number;
  }>;
}

interface FleetCoverage {
  summary: {
    applications: number;
    holdingData: number;
    protected: number;
    toVerify: number;
    notBackedUpByChoice?: number;
    alarms: number;
  };
  applications: Array<
    DecidedApp & {
      holdsData: boolean;
      coverage: string;
      alarm: boolean;
      policy: { name: string } | null;
      lastSuccessAt: string | null;
    }
  >;
}

/**
 * The interesting cases are the gaps *between* engines — an application whose
 * only copy is a clone that its own deletion would remove, a volume the last
 * copy had to leave out — so every engine is answered here together rather
 * than one command at a time.
 */
interface AppProtection {
  protectedOffCluster: boolean;
  coverage?: (DecidedApp & { coverage: string }) | null;
  beforeDeploy?: {
    enabled: boolean;
    required: boolean;
    takes: { restorePoint: boolean; dump: boolean; volumes: boolean };
    warning?: string;
  } | null;
  policies: Array<{
    name: string;
    enabled: boolean;
    destination: { name: string } | null;
    lastRun: { status: string; at: string | null; error: string | null } | null;
  }>;
}

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
    const apiKey = cfg.getApiKeyOrThrow();
    return new ApiClient({ baseUrl: cfg.getApiUrlOrThrow(), apiKey });
  }

  private async forFleet(): Promise<unknown> {
    const api = this.apiClient();
    const [status, coverage] = await Promise.all([
      api.get<FleetStatus>('/backups/status'),
      api.get<FleetCoverage>('/fleet/backup-protection').catch(() => null),
    ]);
    if (this.jsonEnabled()) return { ...status, applications: coverage };

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
      this.log(chalk.red(`  Unusable destinations   ${s.failedDestinations}`));
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
        for (const line of alertItemLines(alert.items)) {
          this.log(chalk.dim(`      ${line}`));
        }
      }
    }
    this.printClusters(status);
    if (coverage) this.printCoverage(coverage);
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

    const [pitr, artifacts, protection] = await Promise.all([
      api
        .get<DbPitrStatus>(`/applications/${app.id}/db-pitr/status`)
        .catch(() => null),
      BackupClient.fromConfig()
        .listArtifacts({ applicationId: app.id })
        .catch(() => [] as BackupArtifact[]),
      api
        .get<AppProtection>(`/applications/${app.id}/backup-protection`)
        .catch(() => null),
    ]);

    const copies = artifacts.filter((a) => a.engineClass === 'volume_copy');
    const offCluster = copies.filter(
      (a) => a.manifestSummary?.sink === 's3-archive',
    );
    const result = {
      application: app.slug,
      pitr,
      copies: copies.length,
      protection,
    };
    if (!this.jsonEnabled()) {
      this.log('');
      this.log(`  ${chalk.bold(app.slug)}`);
      this.log('');

      if (protection?.coverage?.coverage === 'not_backed_up_by_choice') {
        this.log(`  ${chalk.yellow(decisionLine(protection.coverage))}`);
        this.log(
          chalk.dim(
            `  flui app backup skip ${app.slug} --undo   back it up again`,
          ),
        );
        this.log('');
      }
      const on = pitr?.continuousBackupEnabled;
      this.printContinuous(on, pitr);
      this.printPolicies(protection);
      this.printCopies(copies);
      this.printVerdict(
        on,
        copies.length,
        offCluster.length,
        pitr?.pointInTime === false,
      );
      this.log('');
    }
    return result;
  }

  /** Which clusters protect every application automatically, and what needs a decision. */
  private printClusters(status: FleetStatus) {
    const clusters = status.clusters ?? [];
    if (clusters.length === 0) return;
    this.log('');
    this.log(`  ${chalk.bold('Clusters')}`);
    for (const c of clusters) {
      const mark = c.protected ? chalk.green('✓') : chalk.dim('–');
      let how = 'not protected as a whole (`flui backup enable cluster`)';
      if (c.protected) {
        how = c.pending
          ? `new applications get a policy; ${c.pending} not protected yet (waiting to run or retried)`
          : 'every application protected, new ones included';
      }
      this.log(`    ${mark} ${c.name}  ${chalk.dim(how)}`);
    }
    printNeedsDecision(clusters.flatMap((c) => c.needsDecision));
  }

  /** Applications holding data, the unprotected ones first. */
  private printCoverage(coverage: FleetCoverage) {
    const s = coverage.summary;
    const byChoice = s.notBackedUpByChoice ?? 0;
    const protectedShare = chalk.dim(
      `(${s.protected} protected${byChoice ? `, ${byChoice} not backed up by choice` : ''})`,
    );
    this.log('');
    this.log(`  Apps holding data       ${s.holdingData}  ${protectedShare}`);
    const shown = coverage.applications.filter(
      (a) =>
        a.holdsData &&
        a.coverage !== 'protected' &&
        a.coverage !== 'not_backed_up_by_choice',
    );
    for (const a of shown) {
      const mark = a.alarm ? chalk.red('✗') : chalk.yellow('?');
      this.log(
        `    ${mark} ${coverageAppLabel(a)}  ${chalk.dim(coverageAppReason(a))}`,
      );
    }
    const decided = coverage.applications.filter(
      (a) => a.coverage === 'not_backed_up_by_choice',
    );
    if (decided.length === 0) return;
    this.log('');
    this.log(`  Not backed up by choice ${decided.length}`);
    for (const a of decided) {
      this.log(
        `    ${chalk.dim('–')} ${coverageAppLabel(a)}  ${chalk.dim(decisionLine(a))}`,
      );
    }
  }

  /** Every policy covering the app, with where it writes and its last run. */
  private printPolicies(protection: AppProtection | null) {
    this.printBeforeDeploy(protection?.beforeDeploy);
    if (!protection?.policies.length) return;
    this.log(`  ${chalk.bold('Backup policies')}`);
    for (const p of protection.policies) {
      this.log(this.policyLine(p));
      if (p.lastRun?.error) this.log(chalk.red(`      ${p.lastRun.error}`));
    }
    this.log('');
  }

  private printBeforeDeploy(before: AppProtection['beforeDeploy'] | undefined) {
    if (!before?.enabled) return;
    const takes = [
      before.takes.restorePoint ? 'a database restore point' : '',
      before.takes.dump ? 'a database dump' : '',
      before.takes.volumes ? 'a copy of the volumes' : '',
    ].filter(Boolean);
    const what = takes.length ? takes.join(', ') : chalk.yellow('nothing yet');
    const required = before.required ? chalk.dim('  (required)') : '';
    this.log(`  ${chalk.bold('Before each deploy')}  ${what}${required}`);
    if (before.warning) this.log(chalk.yellow(`    ${before.warning}`));
    this.log('');
  }

  private policyLine(p: AppProtection['policies'][number]): string {
    const last = p.lastRun ? this.describeLastRun(p.lastRun) : 'no run yet';
    const state = p.enabled ? chalk.green('on') : chalk.yellow('stopped');
    return `    ${p.name.padEnd(28)} ${state.padEnd(8)} → ${p.destination?.name ?? '?'}  ${chalk.dim(last)}`;
  }

  private describeLastRun(run: { status: string; at: string | null }): string {
    const at = run.at ? ' ' + run.at.slice(0, 16).replace('T', ' ') : '';
    return `last run ${run.status.replace('_', ' ')}${at}`;
  }

  private printContinuous(on: boolean | undefined, pitr: DbPitrStatus | null) {
    if (on && pitr?.pointInTime === false) {
      this.log(
        `  ${chalk.bold('Scheduled dumps')}     ${chalk.green('on')}${pitr.cronSchedule ? chalk.dim('  ' + pitr.cronSchedule + ' UTC') : ''}`,
      );
      if (pitr.window?.newest) {
        this.log(
          `    ${pitr.backupCount ?? 0} dump(s), newest ${pitr.window.newest.replace('T', ' ').slice(0, 19)}${chalk.dim('  (restores that moment, into a new database)')}`,
        );
      }
      return;
    }
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
      `    up to               ${pitr.window.newest?.replace('T', ' ').slice(0, 19) ?? 'now'}${chalk.dim('  (last change archived)')}`,
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
    dumps = false,
  ) {
    this.log('');
    if (on) {
      this.log(
        chalk.green(
          dumps
            ? '  Protected off-cluster by scheduled dumps: a restore returns the latest one.'
            : '  Protected off-cluster, with point-in-time recovery.',
        ),
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
