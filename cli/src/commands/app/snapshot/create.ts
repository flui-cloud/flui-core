import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { formatBytes } from '../../../lib/format-bytes';
import { renderCopyRefusal } from '../../../lib/render-copy-refusal';

export default class AppSnapshotCreate extends Command {
  static readonly description =
    'Take a copy of an application volume, kept on the cluster beside it. ' +
    'Each copy is a full volume of the same size, and is paid for as one ' +
    'until you delete it.';

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
        'Which volume to copy, when the application has more than one.',
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
      if (snap.sourcePvcName) {
        console.log(`  ${chalk.bold('Volume:')}    ${snap.sourcePvcName}`);
      }
      if (snap.sizeGb !== undefined) {
        const actual =
          snap.actualBytes === undefined
            ? 'unknown'
            : formatBytes(snap.actualBytes);
        console.log(`  ${chalk.bold('Volume size:')} ${snap.sizeGb} GiB`);
        console.log(`  ${chalk.bold('Data copied:')} ${actual}`);
      }
      console.log(
        `  ${chalk.bold('Copy ready:')} ${snap.ready ? 'yes' : 'pending'}`,
      );
      if (snap.interruptionSeconds !== undefined) {
        console.log(
          `  ${chalk.bold('Stopped for:')} ${snap.interruptionSeconds}s` +
            (snap.applicationBack
              ? ' — the application is answering again'
              : chalk.yellow(
                  ' — the application was not ready yet when Flui stopped waiting; check it',
                )),
        );
      }
      console.log(`  ${chalk.bold('Created:')}   ${snap.createdAt}`);

      const caps = snap.providerCapabilities;
      if (!caps.pvcCloneSupportsCheapRetention) {
        console.log('');
        console.log(
          chalk.yellow(
            '  ! Each copy is paid for as a full volume — delete it when no longer needed:',
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
