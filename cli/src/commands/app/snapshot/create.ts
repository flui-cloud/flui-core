import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { formatBytes } from '../../../lib/format-bytes';
import { renderCopyRefusal } from '../../../lib/render-copy-refusal';

export default class AppSnapshotCreate extends Command {
  static readonly description =
    'Create a snapshot of an application volume. Today on every provider this ' +
    'is a full PVC clone built via the copy-pod export primitive (sink=pvc-clone) ' +
    'because workload PVCs use local-path. Cost: a full Volume per snapshot.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app',
    '<%= config.bin %> <%= command.id %> my-app --description before-upgrade',
    '<%= config.bin %> <%= command.id %> my-app --volume data',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    volume: Flags.string({
      char: 'v',
      description:
        'Volume (PVC) name when the app has multiple volumes. Required if more than one PVC exists.',
    }),
    description: Flags.string({
      char: 'd',
      description: 'Optional human-friendly tag appended to the snapshot id',
    }),
    pause: Flags.boolean({
      default: false,
      description:
        'Stop the workloads holding the volume, copy it at rest, then start ' +
        'them again. A deliberate outage for the length of the copy.',
      exclusive: ['allow-inconsistent'],
    }),
    'allow-inconsistent': Flags.boolean({
      default: false,
      description:
        'Copy even though the volume holds a database that is being written to. ' +
        'The copy may not restore cleanly.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppSnapshotCreate);
    const spinner = ora(`Creating snapshot for "${args.name}"...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const snap = await service.createAppSnapshot(app.id, {
        volumeName: flags.volume,
        description: flags.description,
        allowInconsistent: flags['allow-inconsistent'],
        pause: flags.pause,
      });

      spinner.succeed(`Snapshot created: ${snap.exportId}`);
      if (snap.warning) {
        console.log('');
        console.log(chalk.yellow(`  ! ${snap.warning}`));
      }
      console.log('');
      console.log(`  ${chalk.bold('Provider:')}  ${snap.provider}`);
      console.log(`  ${chalk.bold('Sink:')}      ${snap.sink}`);
      console.log(`  ${chalk.bold('Namespace:')} ${snap.namespace}`);
      if (snap.sourcePvcName) {
        console.log(`  ${chalk.bold('Source:')}    ${snap.sourcePvcName}`);
      }
      if (snap.sizeGb !== undefined) {
        const actual =
          snap.actualBytes === undefined
            ? 'unknown'
            : formatBytes(snap.actualBytes);
        console.log(`  ${chalk.bold('Source request:')}  ${snap.sizeGb} GiB`);
        console.log(`  ${chalk.bold('Disk usage:')}      ${actual}`);
      }
      console.log(
        `  ${chalk.bold('Ready:')}     ${snap.ready ? 'yes' : 'pending'}`,
      );
      console.log(`  ${chalk.bold('Created:')}   ${snap.createdAt}`);

      const caps = snap.providerCapabilities;
      if (!caps.pvcCloneSupportsCheapRetention) {
        console.log('');
        console.log(
          chalk.yellow(
            '  ! pvc-clone snapshots are billed as a full Volume each — delete when no longer needed:',
          ),
        );
        console.log(
          chalk.yellow(
            `     flui app snapshot delete ${args.name} ${snap.exportId}`,
          ),
        );
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Snapshot creation failed');
      if (renderCopyRefusal(error, `flui app snapshot create ${args.name}`)) {
        this.exit(1);
      }
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
