import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { confirmPrompt } from '../../../lib/prompts';

export default class AppSnapshotSwap extends Command {
  static readonly description =
    'Swap the application volume to a different PVC (typically one created by `flui app snapshot restore`). Triggers a rolling restart. The previous PVC is preserved as a backup.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app my-app-data-restored-20260511',
    '<%= config.bin %> <%= command.id %> my-app new-pvc --volume data --force',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    newPvcName: Args.string({
      description: 'PVC name to swap into the application',
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
      description: 'Application volume name (default: the single volume)',
    }),
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppSnapshotSwap);
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const volumeName = flags.volume ?? 'data';
      if (!flags.force) {
        const ok = await confirmPrompt(
          `Swap volume "${volumeName}" of "${args.name}" to PVC "${args.newPvcName}"? This triggers a rolling restart.`,
        );
        if (!ok) {
          console.log(chalk.dim('  Aborted.'));
          return;
        }
      }
      const spinner = ora(
        `Swapping ${volumeName} → ${args.newPvcName}...`,
      ).start();
      await service.swapAppVolume(app.id, volumeName, args.newPvcName);
      spinner.succeed('Swap applied, rolling restart triggered');
      console.log(
        chalk.dim(
          `\n  Old PVC kept as backup. Use \`flui env kubectl get pvc -n <ns>\` to inspect, delete when ready.`,
        ),
      );
    } catch (error: any) {
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
