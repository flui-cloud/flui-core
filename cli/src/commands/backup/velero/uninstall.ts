import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../../lib/api-client';
import { BackupClient, VeleroFootprint } from '../../../lib/backup-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { printContextBanner } from '../../../lib/context-banner';
import { followOperation } from '../../../lib/follow-operation';
import { formatBytes } from '../../../lib/format-bytes';
import { confirmPrompt } from '../../../lib/prompts';
import { resolveClusterRef } from '../../../lib/resolve-cluster';

interface UninstallResult {
  removed?: string[];
  released?: number;
  kept?: string[];
  stillPresent?: string[];
  leftInDestinations?: VeleroFootprint['leftInDestinations'];
}

export default class BackupVeleroUninstall extends Command {
  static readonly description =
    'Remove Velero, the cluster backup engine Flui used before, from a cluster: its controller, ' +
    'node agent, bucket credentials, cluster-wide binding, resource definitions and namespace. ' +
    'Only what Flui installed is removed. The backups it wrote stay in their destination, and ' +
    'nothing can restore them from Flui any more. Running it again continues where it stopped.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> workload-cluster-1 --plan',
    '<%= config.bin %> <%= command.id %> workload-cluster-1',
    '<%= config.bin %> <%= command.id %> workload-cluster-1 --yes --no-wait',
  ];

  static readonly args = {
    cluster: Args.string({
      description: 'Cluster name or ID (default: the only cluster)',
      required: false,
    }),
  };

  static readonly flags = {
    plan: Flags.boolean({
      description: 'Show what would be removed and change nothing',
      default: false,
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Do not ask for confirmation',
      default: false,
    }),
    'no-wait': Flags.boolean({
      description: 'Start the removal and return its operation id',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupVeleroUninstall);
    printContextBanner();
    const { id: clusterId, name } = await resolveClusterRef(args.cluster);
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    const client = new BackupClient(api);

    let footprint: VeleroFootprint;
    try {
      footprint = await client.getVeleroFootprint(clusterId);
    } catch (error: any) {
      this.fail(error);
    }
    this.printFootprint(name, footprint);

    if (flags.plan) return;
    if (!(await this.confirmRemoval(name, footprint, flags.yes))) return;

    let operationId: string;
    let alreadyRunning: boolean;
    try {
      ({ operationId, alreadyRunning } =
        await client.uninstallVelero(clusterId));
    } catch (error: any) {
      this.fail(error);
    }
    if (alreadyRunning) {
      console.log(chalk.dim(`  A removal is already running on ${name}.`));
    }
    if (flags['no-wait']) {
      console.log(
        `  Removal started (operation ${operationId}).\n` +
          chalk.dim(`  flui operation ${operationId} --follow\n`),
      );
      return;
    }

    const spinner = ora(`Removing Velero from ${name}...`).start();
    const op = await followOperation<UninstallResult>(api, operationId, {
      intervalMs: 3000,
    });
    if (op?.status !== 'COMPLETED') {
      spinner.fail(
        op?.errorMessage ??
          `Still running — follow it with: flui operation ${operationId} --follow`,
      );
      if (op) this.exit(1);
      return;
    }
    spinner.succeed(`Velero removed from ${name}`);
    this.printResult(op.metadata ?? {});
  }

  private async confirmRemoval(
    name: string,
    footprint: VeleroFootprint,
    yes: boolean,
  ): Promise<boolean> {
    if (footprint.reachable && !footprint.installed) {
      console.log(chalk.green(`  Nothing to remove on ${name}.\n`));
      return false;
    }
    if (footprint.reachable && !footprint.installedByFlui) {
      console.log(
        chalk.yellow(
          `  The "velero" namespace on ${name} was not created by Flui, so nothing is removed.\n`,
        ),
      );
      this.exit(1);
    }
    if (!yes && !(await confirmPrompt(`Remove Velero from ${name}?`, false))) {
      console.log(chalk.dim('  Nothing was changed.\n'));
      return false;
    }
    return true;
  }

  private printResult(result: Partial<UninstallResult>): void {
    for (const item of result.removed ?? []) {
      console.log(chalk.dim(`    removed ${item}`));
    }
    for (const note of result.kept ?? []) {
      console.log(chalk.yellow(`    ${note}`));
    }
    for (const item of result.stillPresent ?? []) {
      console.log(chalk.yellow(`    still present: ${item}`));
    }
    this.printLeftBehind(result.leftInDestinations ?? []);
    console.log('');
  }

  private printFootprint(name: string, f: VeleroFootprint): void {
    console.log('');
    console.log(chalk.bold(`  Velero on ${name}`));
    if (!f.reachable) {
      console.log(
        chalk.yellow(
          '    The cluster could not be read; nothing is known about what is on it.',
        ),
      );
    } else {
      console.log(`    namespace velero: ${f.namespace}`);
      for (const c of f.components) {
        const mark = c.present ? chalk.yellow('present') : chalk.dim('absent');
        console.log(`    ${c.kind}/${c.name}: ${mark}`);
      }
      console.log(
        `    resource definitions: ${f.definitions.length}` +
          (f.objects ? `, ${f.objects} object(s) in its namespace` : ''),
      );
      if (f.objectsElsewhere) {
        console.log(
          chalk.yellow(
            `    ${f.objectsElsewhere} object(s) of its kinds exist in other namespaces: the definitions will be kept.`,
          ),
        );
      }
    }
    if (f.pausedPolicies.length) {
      console.log(
        `    policies it ran (paused, cannot run again): ${f.pausedPolicies
          .map((p) => p.name)
          .join(', ')}`,
      );
      console.log(
        chalk.dim(
          '    protect the cluster instead: flui backup enable cluster --cluster ' +
            name,
        ),
      );
    }
    this.printLeftBehind(f.leftInDestinations);
    if (f.inFlightOperationId) {
      console.log(
        chalk.dim(
          `    a removal is running: operation ${f.inFlightOperationId}`,
        ),
      );
    }
    console.log('');
  }

  private printLeftBehind(left: VeleroFootprint['leftInDestinations']): void {
    for (const d of left) {
      const where = [d.bucket, d.prefix].filter(Boolean).join('/');
      console.log(
        chalk.dim(
          `    ${d.backups} backup(s) it wrote stay in ${d.destinationName ?? d.destinationId} (${where}); delete them there when you no longer want them.`,
        ),
      );
      const data = d.volumeData ?? [];
      if (data.length === 0) continue;
      console.log(
        chalk.dim(
          "    and the volume data it copied, folder by folder (delete only these: kopia/ also holds Flui's volume backups):",
        ),
      );
      for (const v of data) {
        console.log(
          chalk.dim(
            `      ${[d.bucket, v.prefix].filter(Boolean).join('/')}  ${formatBytes(v.bytes)}`,
          ),
        );
      }
    }
  }

  private fail(error: any): never {
    const msg = error?.details?.message ?? error?.message ?? String(error);
    console.log(chalk.red(`\n  ${msg}\n`));
    this.exit(1);
  }
}
