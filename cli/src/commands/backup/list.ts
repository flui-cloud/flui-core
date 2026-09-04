import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient, BackupArtifact } from '../../lib/backup-client';
import { printContextBanner } from '../../lib/context-banner';
import { formatBytes } from '../../lib/format-bytes';

const ENGINE_LABEL: Record<string, string> = {
  volume: 'cluster state',
  database: 'database',
  platform: 'control plane',
  volume_copy: 'volume copy',
};

export default class BackupList extends Command {
  static readonly description =
    'List the backups that exist — every engine in one place. Filter to one ' +
    'application or one cluster.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --app <app-id>',
    '<%= config.bin %> <%= command.id %> --cluster <cluster-id>',
    '<%= config.bin %> <%= command.id %> --app <app-id> --json',
  ];

  static readonly flags = {
    app: Flags.string({ description: 'Application ID' }),
    cluster: Flags.string({ description: 'Cluster ID' }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupList);
    if (!flags.app && !flags.cluster) {
      this.error('Pass --app <id> or --cluster <id> to say what to list.');
    }
    printContextBanner();

    const client = BackupClient.fromConfig();
    const spinner = ora('Reading the backup ledger...').start();
    let items: BackupArtifact[];
    try {
      items = await client.listArtifacts({
        applicationId: flags.app,
        clusterId: flags.cluster,
      });
    } catch (err) {
      spinner.fail(`Could not list backups: ${(err as Error).message}`);
      this.exit(1);
    }
    spinner.stop();

    if (flags.json) {
      this.log(JSON.stringify(items, null, 2));
      return;
    }
    if (items.length === 0) {
      this.log(chalk.yellow('\n   No backups recorded.\n'));
      return;
    }

    this.log('');
    this.log(
      `   ${chalk.bold('WHEN'.padEnd(20))} ${chalk.bold('PROTECTS'.padEnd(14))} ` +
        `${chalk.bold('SIZE'.padEnd(10))} ${chalk.bold('WHERE'.padEnd(10))} ` +
        `${chalk.bold('TAKEN'.padEnd(10))} ${chalk.bold('ID')}`,
    );
    this.log('   ' + '─'.repeat(118));
    for (const a of items) {
      const when = (a.createdAt ?? '')
        .replace('T', ' ')
        .slice(0, 19)
        .padEnd(20);
      const what = (
        ENGINE_LABEL[a.engineClass ?? ''] ??
        a.engineClass ??
        '—'
      ).padEnd(14);
      const size = (
        a.sizeBytes ? formatBytes(Number(a.sizeBytes)) : '—'
      ).padEnd(10);
      const where = this.placeOf(a).padEnd(10);
      const taken = this.takenAs(a).padEnd(10);
      this.log(
        `   ${when} ${what} ${size} ${where} ${taken} ${chalk.dim(a.id)}`,
      );
    }
    this.log('');
    this.log(chalk.dim(`   ${items.length} backup(s)`));

    if (items.some((a) => a.manifestSummary?.sink === 'pvc-clone')) {
      this.log(
        chalk.dim(
          '   in-cluster copies are removed with the application — only off-cluster ones survive it',
        ),
      );
    }
    if (items.some((a) => this.takenAs(a) === 'engine')) {
      this.log(
        chalk.dim(
          '   engine = the database wrote a consistent image first; nothing was stopped',
        ),
      );
    }
    if (items.some((a) => this.takenAs(a).startsWith('live'))) {
      this.log(
        chalk.dim(
          '   live · N = copied with N process(es) writing to the volume; for a database prefer continuous backup',
        ),
      );
    }
    if (items.some((a) => this.takenAs(a) === '—')) {
      this.log(
        chalk.dim(
          '   —  = taken before Flui recorded this, not a statement about the copy',
        ),
      );
    }
    this.log('');
  }

  private takenAs(a: BackupArtifact): string {
    const quiesce = a.manifestSummary?.quiesce;
    if (quiesce === 'writers-stopped') return 'at rest';
    if (quiesce === 'engine-hook') return 'engine';
    if (quiesce !== 'none') return '—';
    const writers = a.manifestSummary?.writersAtStart;
    return typeof writers === 'number' ? `live · ${writers}` : 'live';
  }

  private placeOf(a: BackupArtifact): string {
    if (a.manifestSummary?.sink === 'pvc-clone') return 'in-cluster';
    return a.locations?.length || a.manifestSummary?.bucket
      ? 'object store'
      : '—';
  }
}
