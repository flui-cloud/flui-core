import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import {
  BackupClient,
  NeedsDecisionItem,
  ProtectedApp,
} from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { followOperation } from '../../../lib/follow-operation';
import { parseDestinations } from '../../../lib/backup-enable';
import {
  describeProtectedApp,
  printNeedsDecision,
} from '../../../lib/cluster-protection-format';

export default class BackupEnableCluster extends Command {
  static readonly description =
    'Protect every application on a cluster, including the ones installed ' +
    'later: each gets a backup policy of its own with the engine that fits it ' +
    '(continuous backup or dumps for PostgreSQL and MariaDB, encrypted ' +
    'deduplicated copies for other volumes). Databases Flui cannot back up ' +
    'consistently are listed for you to decide instead of being copied.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --destination <destId>',
    '<%= config.bin %> <%= command.id %> --destination <destId> --destination <replicaId>:replica',
    '<%= config.bin %> <%= command.id %> --destination <destId> --before-deploy',
  ];

  static readonly flags = {
    destination: Flags.string({
      char: 'D',
      required: true,
      multiple: true,
      description:
        'Where the backups go: <destId>[:primary|replica] (repeatable). A replica receives a copy of the volume backups after each run. See `flui backup destination list`.',
    }),
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    schedule: Flags.string({
      description:
        'One cron schedule in UTC for every policy. Omit it to use the default of each kind of backup, spread across the night.',
    }),
    'retention-days': Flags.integer({ min: 1, default: 30 }),
    'before-deploy': Flags.boolean({
      default: false,
      description:
        'Before each deploy, record a restore point for databases and start a copy of the other volumes.',
    }),
    'first-backup': Flags.boolean({
      default: true,
      allowNo: true,
      description: 'Take the first volume backup of each application now.',
    }),
    'no-wait': Flags.boolean({
      default: false,
      description: 'Return once protection is recorded, without following it.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupEnableCluster);
    printContextBanner();

    const { id: clusterId, name } = await resolveClusterRef(flags.cluster);
    const destinations = parseDestinations(flags.destination);
    const primary = destinations.filter((d) => d.role === 'primary');
    const replicas = destinations.filter((d) => d.role === 'replica');
    if (primary.length !== 1 || replicas.length > 1) {
      this.error(
        'Give exactly one primary destination, and at most one replica.',
        {
          exit: 1,
        },
      );
    }

    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    const client = new BackupClient(api);
    const spinner = ora(`Protecting every application on ${name}...`).start();
    let operationId: string;
    try {
      ({ operationId } = await client.protectCluster(clusterId, {
        destinationId: primary[0].destinationId,
        ...(replicas[0]
          ? { replicaDestinationId: replicas[0].destinationId }
          : {}),
        cronSchedule: flags.schedule,
        retentionDays: flags['retention-days'],
        beforeDeploy: flags['before-deploy'],
        runFirstBackup: flags['first-backup'],
      }));
    } catch (error: any) {
      spinner.fail('Could not protect the cluster');
      const msg = error.details?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  ${msg}\n`));
      this.exit(1);
    }

    if (flags['no-wait']) {
      spinner.succeed(
        `Cluster protected; policies are being created (operation ${operationId})`,
      );
      console.log(
        chalk.dim(`\n   flui backup status   what each application got\n`),
      );
      return;
    }

    const printed = new Set<string>();
    const op = await followOperation<{ apps?: ProtectedApp[] }>(
      api,
      operationId,
      {
        intervalMs: 3000,
        onUpdate: (current) => {
          for (const app of current.metadata?.apps ?? []) {
            if (printed.has(app.applicationId)) continue;
            printed.add(app.applicationId);
            spinner.stop();
            console.log(describeProtectedApp(app));
            spinner.start();
          }
        },
      },
    );
    if (op?.status !== 'COMPLETED') {
      spinner.fail(
        op?.errorMessage ??
          `Still running — follow it with: flui operation ${operationId} --follow`,
      );
      if (op) this.exit(1);
      return;
    }
    spinner.succeed(
      `${name} is protected: applications installed from now on get a policy too`,
    );

    const protection = await client
      .getClusterProtection(clusterId)
      .catch(() => null);
    const decisions: NeedsDecisionItem[] = protection?.needsDecision ?? [];
    printNeedsDecision(decisions);
    console.log(
      chalk.dim('   flui backup status              what is protected and how'),
    );
    console.log(
      chalk.dim(
        '   flui backup disable cluster     stop protecting new applications',
      ),
    );
    console.log('');
  }
}
