import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { archLabel, armWarningLine } from '../../lib/server-architecture-view';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { printContextBanner } from '../../lib/context-banner';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { ClusterNodeScalingService } from 'src/modules/infrastructure/clusters/services/cluster-node-scaling.service';
import { ClusterCapacityService } from 'src/modules/infrastructure/clusters/services/cluster-capacity.service';
import { CliNodeRepository } from '../../lib/repositories/cli-node.repository';
import { NodeType } from 'src/modules/infrastructure/clusters/entities/cluster-node.entity';
import { confirmByTypingPrompt } from '../../lib/prompts';

export default class EnvScaleMaster extends Command {
  static readonly description =
    'Vertically scale the master node to a new server type. Planned-maintenance operation: ' +
    'powers off the master, changes its provider server type, powers it back on and waits ' +
    'for k3s Ready. Expected downtime ~3–5 min. Any pod pinned to the master (dedicated DBs) ' +
    'will be unavailable during this window — snapshot them first.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --type cx32',
    '<%= config.bin %> <%= command.id %> --type PRO2-S --confirm',
  ];

  static readonly flags = {
    type: Flags.string({
      char: 't',
      description:
        'Target provider server type name. If omitted, auto-picks the next-bigger upgrade candidate (smallest +€/month delta).',
    }),
    upgradeDisk: Flags.boolean({
      description:
        '[Hetzner] Also grow the local OS disk. One-way: you cannot downgrade later.',
      default: false,
    }),
    confirm: Flags.boolean({
      description: 'Skip the typed confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvScaleMaster);
    printContextBanner();
    const spinner = ora('Preparing scale-master plan...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const nodeRepo = app.get(CliNodeRepository);
      const capacityService = app.get(ClusterCapacityService);
      const scalingService = app.get(ClusterNodeScalingService);

      const cluster = await controlService.getControlCluster();
      if (!cluster) {
        spinner.fail('No control cluster found');
        return;
      }
      const nodes = await nodeRepo.find({ where: { clusterId: cluster.id } });
      const master = nodes.find((n) => n.nodeType === NodeType.MASTER);
      if (!master) {
        spinner.fail('Master node not found in this cluster');
        return;
      }
      const preview = await scalingService.previewScaleNode(
        cluster.id,
        master.id,
      );
      // Capacity plan is best-effort: it depends on k8s API access which
      // may not be reachable from the workstation (the master k8s API is
      // typically firewalled to the cluster's source CIDR, or only reachable
      // via an SSH tunnel that becomes unreliable during a reboot). When the
      // plan fails, we still proceed with the explicit --type flag.
      let plan: Awaited<ReturnType<typeof capacityService.getPlan>> | undefined;
      try {
        plan = await capacityService.getPlan(cluster.id);
      } catch (err) {
        this.warn(
          `Capacity plan unavailable (${(err as Error).message}). ` +
            'Proceeding without cost/candidate table.',
        );
      }
      spinner.succeed('Plan computed');

      let targetType = flags.type;
      let cand = targetType
        ? plan?.candidates.find((c) => c.name === targetType)
        : undefined;
      if (!targetType) {
        if (!plan) {
          console.log(
            chalk.red(
              '\n❌ Cannot auto-pick a type without the capacity plan. Pass --type explicitly.\n',
            ),
          );
          this.exit(1);
        }
        cand = plan.candidates.find((c) => c.direction === 'upgrade');
        if (!cand) {
          console.log(
            chalk.red(
              '\n❌ No upgrade candidate available from the provider catalog. Pass --type explicitly (e.g. for a downgrade).\n',
            ),
          );
          this.exit(1);
        }
        targetType = cand.name;
        console.log(
          chalk.dim(
            `   (auto-selected next-bigger type: ${chalk.bold(targetType)})`,
          ),
        );
      }

      console.log(chalk.cyan('\n🖥  Scale Master Plan\n'));
      console.log(`   ${chalk.bold('Cluster:')}     ${cluster.name}`);
      console.log(`   ${chalk.bold('Node:')}        ${preview.node.name}`);
      console.log(
        `   ${chalk.bold('From:')}        ${preview.node.currentServerType}`,
      );
      console.log(
        `   ${chalk.bold('To:')}          ${targetType}${cand ? ` (${archLabel(cand.architecture)})` : ''}`,
      );
      if (archLabel(cand?.architecture) === 'arm') {
        console.log(`   ${armWarningLine()}`);
      }
      if (cand) {
        let deltaStr: string;
        if (cand.monthlyDeltaEur === 'n/a') deltaStr = 'n/a';
        else {
          const sign = Number.parseFloat(cand.monthlyDeltaEur) > 0 ? '+' : '';
          deltaStr = sign + cand.monthlyDeltaEur;
        }
        console.log(
          `   ${chalk.bold('Cost/month:')}  €${cand.monthlyCostEur} (${deltaStr} delta)`,
        );
        console.log(
          `   ${chalk.bold('Resources:')}   ${cand.cores} CPU, ${cand.memoryGb} GB RAM, ${cand.diskGb} GB disk`,
        );
      } else {
        console.log(
          chalk.dim(`   ${chalk.bold('Cost/month:')}  (unavailable)`),
        );
      }
      console.log(
        `   ${chalk.bold('Downtime:')}    ~${Math.round(preview.expectedDowntimeMs / 60000)} min`,
      );
      if (preview.affectedDedicatedApps.length > 0) {
        console.log(
          chalk.yellow(
            `\n   ⚠️  Affected dedicated workloads (${preview.affectedDedicatedApps.length}):`,
          ),
        );
        for (const app of preview.affectedDedicatedApps) {
          console.log(chalk.yellow(`     • ${app.slug}`));
        }
        console.log(
          chalk.yellow(`\n   These pods will be stopped for the duration.`),
        );
        console.log(
          chalk.dim(
            `   Snapshot first with: flui app snapshot create <slug>\n`,
          ),
        );
      }
      if (flags.upgradeDisk) {
        console.log(
          chalk.yellow(
            '\n   ⚠️  --upgradeDisk is ONE-WAY. After this, you can never downgrade to a smaller type.\n',
          ),
        );
      }

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
        text: `Scaling master to ${targetType}...`,
        color: 'yellow',
      }).start();
      try {
        const op = await scalingService.scaleNode(cluster.id, master.id, {
          targetServerType: targetType,
          upgradeDisk: flags.upgradeDisk,
        });
        run.succeed(`Master scaled. Operation ${op.id} → ${op.status}`);
      } catch (error) {
        run.fail('Scale-master failed');
        throw error;
      }
      console.log('');
    } catch (error) {
      console.log(chalk.red('\n❌ Error:\n'));
      console.log(
        `   ${error instanceof Error ? error.message : String(error)}\n`,
      );
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
