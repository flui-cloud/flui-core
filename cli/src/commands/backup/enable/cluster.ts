import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import {
  SHARED_ENABLE_FLAGS,
  parseDestinations,
  printEnabled,
  profileFor,
} from '../../../lib/backup-enable';

export default class BackupEnableCluster extends Command {
  static readonly description =
    'Protect a cluster: its Kubernetes objects, and the volumes Velero can ' +
    'reach. Dedicated volumes — the ones databases use — are not covered by ' +
    'this; protect a database with `flui backup enable database`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --destination <destId>',
    '<%= config.bin %> <%= command.id %> --destination <destId> --namespaces team-a,team-b',
    '<%= config.bin %> <%= command.id %> --destination <destId> --schedule "0 2 * * *"',
  ];

  static readonly flags = {
    ...SHARED_ENABLE_FLAGS,
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    namespaces: Flags.string({
      description:
        'Comma-separated namespaces to narrow to. Omit to protect the whole cluster.',
    }),
    'include-volumes': Flags.boolean({
      default: true,
      allowNo: true,
      description:
        'Copy the contents of volumes Velero can reach, not just the objects.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupEnableCluster);
    printContextBanner();

    const { id: clusterId } = await resolveClusterRef(flags.cluster);
    const namespaces = flags.namespaces
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const client = BackupClient.fromConfig();
    const destinations = parseDestinations(flags.destination);
    const spinner = ora('Enabling cluster backup...').start();
    try {
      const policy = await client.createPolicy({
        name: flags.name ?? `cluster-${namespaces ? 'namespaces' : 'all'}`,
        clusterId,
        engineClass: 'volume',
        scope: namespaces?.length ? 'namespaces' : 'cluster_all',
        ...(namespaces?.length ? { scopeSelector: { namespaces } } : {}),
        includePvcs: flags['include-volumes'],
        cronSchedule: flags.schedule,
        retentionDays: flags['retention-days'],
        retentionMaxCopies: flags['retention-max-copies'],
        enabled: flags.enabled,
        destinations,
        profile: profileFor(destinations),
      });
      spinner.succeed('Cluster backup enabled');
      printEnabled(
        policy,
        namespaces?.length
          ? `namespaces ${namespaces.join(', ')}`
          : 'the whole cluster',
        flags.schedule ?? 'on the default schedule',
      );
      if (flags['include-volumes']) {
        console.log(
          chalk.dim(
            '   Volumes on dedicated storage (databases) are skipped by this engine —\n' +
              '   each run records which ones, and `flui backup status` shows the gap.',
          ),
        );
        console.log('');
      }
    } catch (error: any) {
      spinner.fail('Could not enable cluster backup');
      const msg = error.details?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  ${msg}\n`));
      this.exit(1);
    }
  }
}
