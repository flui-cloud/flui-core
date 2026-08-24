import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { printContextBanner } from '../../lib/context-banner';
import {
  openControlPlane,
  printControlPlaneError,
} from '../../lib/control-plane-api';
import { findClusterNode } from '../../lib/cluster-nodes';
import type { ClusterCapacityPlanDto } from 'src/modules/infrastructure/clusters/dto/cluster-capacity-plan.dto';
import { confirmByTypingPrompt } from '../../lib/prompts';

interface ScaleNodePreview {
  node: { currentServerType: string };
  affectedDedicatedApps: Array<{ slug: string }>;
  expectedDowntimeMs: number;
}

interface OperationSummary {
  id: string;
  status: string;
}

export default class EnvScaleNode extends Command {
  static readonly description =
    'Vertically scale a worker node to a new server type. Planned-maintenance operation. ' +
    'For the master, use `flui env scale-master` instead.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> worker-1 --type cx32',
    '<%= config.bin %> <%= command.id %> worker-1 --type PRO2-S --confirm',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Worker node name (e.g. flui-cluster-worker-1)',
      required: true,
    }),
  };

  static readonly flags = {
    type: Flags.string({
      char: 't',
      description:
        'Target provider server type name. If omitted, auto-picks the next-bigger upgrade candidate (smallest +€/month delta).',
    }),
    upgradeDisk: Flags.boolean({
      description: '[Hetzner] Also grow the local OS disk (one-way).',
      default: false,
    }),
    confirm: Flags.boolean({
      description: 'Skip the typed confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EnvScaleNode);
    printContextBanner();
    const spinner = ora('Preparing scale-node plan...').start();

    try {
      const { cluster, api } = await openControlPlane(await getNestApp());
      const base = `/infrastructure/clusters/${cluster.id}`;
      const target = await findClusterNode(api, cluster.id, args.name);
      const [preview, plan] = await Promise.all([
        api.get<ScaleNodePreview>(`${base}/nodes/${target.id}/scale/preview`),
        api.get<ClusterCapacityPlanDto>(`${base}/capacity-plan`),
      ]);
      spinner.succeed('Plan computed');

      let targetType = flags.type;
      let cand = targetType
        ? plan.candidates.find((c) => c.name === targetType)
        : undefined;
      if (!targetType) {
        cand = plan.candidates.find((c) => c.direction === 'upgrade');
        if (!cand) {
          console.log(
            chalk.red(
              '\n❌ No upgrade candidate available. Pass --type explicitly.\n',
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
      console.log(chalk.cyan('\n🖥  Scale Node Plan\n'));
      console.log(`   ${chalk.bold('Node:')}        ${target.serverName}`);
      console.log(
        `   ${chalk.bold('From:')}        ${preview.node.currentServerType}`,
      );
      console.log(`   ${chalk.bold('To:')}          ${targetType}`);
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
      }
      console.log(
        `   ${chalk.bold('Downtime:')}    ~${Math.round(preview.expectedDowntimeMs / 60000)} min`,
      );
      if (preview.affectedDedicatedApps.length > 0) {
        console.log(
          chalk.yellow(
            `\n   ⚠️  Hosts ${preview.affectedDedicatedApps.length} dedicated workload(s):`,
          ),
        );
        for (const app of preview.affectedDedicatedApps) {
          console.log(chalk.yellow(`     • ${app.slug}`));
        }
      }

      if (!flags.confirm) {
        console.log('');
        console.log(
          chalk.yellow(
            `   To confirm, type the node name exactly: ${chalk.bold(target.serverName)}`,
          ),
        );
        const ok = await confirmByTypingPrompt(
          chalk.yellow('⚠️  Node name'),
          target.serverName,
        );
        if (!ok) {
          console.log(chalk.green('\n✅ Cancelled\n'));
          return;
        }
      }

      const run = ora({
        text: `Scaling ${target.serverName} to ${targetType}...`,
        color: 'yellow',
      }).start();
      try {
        const op = await api.post<OperationSummary>(
          `${base}/nodes/${target.id}/scale`,
          {
            targetServerType: targetType,
            upgradeDisk: flags.upgradeDisk,
          },
        );
        run.succeed(`Node scaled. Operation ${op.id} → ${op.status}`);
      } catch (error) {
        run.fail('Scale-node failed');
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
