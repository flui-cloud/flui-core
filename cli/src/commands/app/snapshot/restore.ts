import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';

export default class AppSnapshotRestore extends Command {
  static readonly description =
    'Restore a snapshot into a new side-by-side PVC. The application is not touched — the new PVC is created in the same namespace and can be promoted later with `flui app snapshot swap`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app my-app-snap-20260510-abcdef',
    '<%= config.bin %> <%= command.id %> my-app my-app-snap-... --swap',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    snapshotId: Args.string({
      description: 'Snapshot id (from `flui app snapshot list`)',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    swap: Flags.boolean({
      description:
        'Immediately swap the restored PVC into the live application (rolling restart). Old PVC is preserved as a backup.',
    }),
    volume: Flags.string({
      char: 'v',
      description:
        'Application volume name to swap when --swap is set. Required if the app has multiple volumes.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppSnapshotRestore);
    const spinner = ora(`Restoring snapshot ${args.snapshotId}...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const result = await service.restoreAppSnapshot(app.id, args.snapshotId);
      spinner.succeed(`Restored to new PVC: ${result.newPvcName}`);

      console.log('');
      console.log(`  ${chalk.bold('App:')}        ${app.name}`);
      console.log(`  ${chalk.bold('From snap:')}  ${args.snapshotId}`);
      console.log(`  ${chalk.bold('New PVC:')}    ${result.newPvcName}`);

      if (flags.swap) {
        const volumeName = flags.volume ?? 'data';
        const swapSpinner = ora(
          `Swapping volume "${volumeName}" to ${result.newPvcName}...`,
        ).start();
        await service.swapAppVolume(app.id, volumeName, result.newPvcName);
        swapSpinner.succeed('Volume swapped, rollout triggered');
        console.log(
          chalk.dim(
            `\n  Old PVC kept as backup. Use \`flui env kubectl get pvc -n <ns>\` to inspect, delete when no longer needed.`,
          ),
        );
      } else {
        console.log('');
        console.log(chalk.dim('  Next steps:'));
        console.log(
          chalk.dim(
            `  flui app snapshot swap ${app.name} ${result.newPvcName}`,
          ),
        );
      }
    } catch (error: any) {
      spinner.fail('Restore failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
