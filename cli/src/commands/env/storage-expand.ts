import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { printContextBanner } from '../../lib/context-banner';
import {
  openControlPlane,
  printControlPlaneError,
} from '../../lib/control-plane-api';
import type { ClusterCapacityPlanDto } from 'src/modules/infrastructure/clusters/dto/cluster-capacity-plan.dto';
import type { ClusterStorageStatusDto } from 'src/modules/infrastructure/clusters/dto/cluster-storage.dto';
import { confirmByTypingPrompt } from '../../lib/prompts';

interface ExpandOperation {
  id: string;
  status: string;
  metadata?: { fsResizeWarning?: string };
}

export default class EnvStorageExpand extends Command {
  static readonly description =
    'Grow the cluster shared-storage backing Volume. Resizes the provider Volume, ' +
    'then runs resize2fs over SSH on the master so the new space is usable. ' +
    'Online for ext4 — no downtime expected. Volumes can only grow.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --size 50',
    '<%= config.bin %> <%= command.id %> --size 100 --confirm',
  ];

  static readonly flags = {
    size: Flags.integer({
      char: 's',
      description:
        'New volume size in GB (must be greater than current). If omitted, defaults to current + 10 GB.',
    }),
    confirm: Flags.boolean({
      description: 'Skip the typed confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvStorageExpand);
    printContextBanner();
    const spinner = ora('Inspecting current storage...').start();

    try {
      const { cluster, api } = await openControlPlane(await getNestApp());
      const base = `/infrastructure/clusters/${cluster.id}`;
      const storage = await api.get<ClusterStorageStatusDto>(`${base}/storage`);
      let plan: ClusterCapacityPlanDto | undefined;
      try {
        plan = await api.get<ClusterCapacityPlanDto>(`${base}/capacity-plan`);
      } catch (err) {
        this.warn(
          `Capacity plan unavailable (${(err as Error).message}). ` +
            'Proceeding without per-GB cost estimate.',
        );
      }
      spinner.succeed('Storage status retrieved');

      if (!storage.volume) {
        console.log(
          chalk.red(
            '\n❌ Cluster has no Flui-managed shared-storage volume to expand.\n',
          ),
        );
        this.exit(1);
      }
      const currentSize = storage.volume.sizeGb;
      const targetSize = flags.size ?? currentSize + 10;
      if (targetSize <= currentSize) {
        console.log(
          chalk.red(
            `\n❌ Target size (${targetSize} GB) must be greater than current (${currentSize} GB). Volumes cannot shrink.\n`,
          ),
        );
        this.exit(1);
      }
      if (flags.size === undefined) {
        const label = `${targetSize} GB`;
        console.log(
          chalk.dim(
            `   (auto-selected target size: ${chalk.bold(label)} = current + 10 GB)`,
          ),
        );
      }

      const deltaGb = targetSize - currentSize;
      const pricePerGb = plan?.storage?.pricePerGbMonthlyEur;
      const monthlyDelta = pricePerGb
        ? (Number.parseFloat(pricePerGb) * deltaGb).toFixed(2)
        : null;

      console.log(chalk.cyan('\n💾 Expand Shared Volume Plan\n'));
      console.log(`   ${chalk.bold('Cluster:')}    ${cluster.name}`);
      console.log(`   ${chalk.bold('Volume:')}     ${storage.volume.volumeId}`);
      console.log(
        `   ${chalk.bold('From:')}       ${currentSize} GB → ${targetSize} GB (+${deltaGb} GB)`,
      );
      if (monthlyDelta) {
        console.log(
          `   ${chalk.bold('Cost:')}       +€${monthlyDelta}/month (€${pricePerGb}/GB)`,
        );
      }
      console.log(`   ${chalk.bold('Downtime:')}   none (online ext4 resize)`);

      if (!flags.confirm) {
        console.log('');
        console.log(
          chalk.yellow(
            `   To confirm, type the cluster name exactly: ${chalk.bold(cluster.name)}`,
          ),
        );
        const ok = await confirmByTypingPrompt(
          chalk.yellow('⚠️  Cluster name'),
          cluster.name,
        );
        if (!ok) {
          console.log(chalk.green('\n✅ Cancelled\n'));
          return;
        }
      }

      const run = ora({
        text: `Expanding volume to ${targetSize} GB...`,
        color: 'yellow',
      }).start();
      try {
        const op = await api.post<ExpandOperation>(`${base}/storage/expand`, {
          targetSizeGb: targetSize,
        });
        run.succeed(`Volume expanded. Operation ${op.id} → ${op.status}`);
        if (op.metadata?.fsResizeWarning) {
          console.log(
            chalk.yellow(
              `   ⚠️  Filesystem resize warning: ${op.metadata.fsResizeWarning}`,
            ),
          );
        }
      } catch (error) {
        run.fail('Volume expand failed');
        throw error;
      }
      console.log('');
    } catch (error) {
      printControlPlaneError(error);
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
