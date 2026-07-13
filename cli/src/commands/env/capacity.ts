import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { ClusterCapacityService } from 'src/modules/infrastructure/clusters/services/cluster-capacity.service';
import {
  ClusterCapacityPlanDto,
  CapacityCandidateDto,
} from 'src/modules/infrastructure/clusters/dto/cluster-capacity-plan.dto';
import { printContextBanner } from '../../lib/context-banner';

export default class EnvCapacity extends Command {
  static readonly description =
    'Show master node capacity (allocatable/used/free) and a sorted list of ' +
    'server-type upgrade/downgrade candidates with monthly cost delta. Use ' +
    'this to plan `flui env scale-master` for apps that need dedicated ' +
    'placement on the master (e.g. databases).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --top 5',
    '<%= config.bin %> <%= command.id %> --direction upgrade',
  ];

  static readonly flags = {
    top: Flags.integer({
      description: 'Limit candidates shown (default: 10)',
      default: 10,
    }),
    direction: Flags.string({
      description: 'Filter candidates: upgrade, downgrade, all (default: all)',
      options: ['all', 'upgrade', 'downgrade'],
      default: 'all',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvCapacity);
    printContextBanner();
    const spinner = ora('Computing capacity plan...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const capacityService = app.get(ClusterCapacityService);

      const cluster = await controlService.getControlCluster();
      if (!cluster) {
        spinner.fail('No control cluster found');
        console.log(
          chalk.yellow(
            '\n⚠️  Create a cluster first: ' + chalk.cyan('flui env create\n'),
          ),
        );
        return;
      }

      const plan = await capacityService.getPlan(cluster.id);
      spinner.succeed('Capacity plan computed');
      this.render(plan, flags.top, flags.direction);
    } catch (error) {
      spinner.fail('Failed to compute capacity plan');
      console.log(chalk.red('\n❌ Error:\n'));
      console.log(
        `   ${error instanceof Error ? error.message : String(error)}\n`,
      );
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private render(
    plan: ClusterCapacityPlanDto,
    top: number,
    direction: string,
  ): void {
    console.log(chalk.cyan('\n📊 Cluster Capacity Plan\n'));
    console.log(`   ${chalk.bold('Cluster:')}  ${plan.clusterId}`);
    console.log(`   ${chalk.bold('Provider:')} ${plan.provider}`);
    if (plan.message) {
      console.log(`   ${chalk.dim(plan.message)}`);
    }

    if (plan.master) {
      const m = plan.master;
      console.log(chalk.cyan('\n🖥  Master Node\n'));
      console.log(`   ${chalk.bold('Node:')}        ${m.nodeName}`);
      console.log(`   ${chalk.bold('Server type:')} ${m.serverType}`);
      console.log(
        `   ${chalk.bold('Allocatable:')} ${fmtCpu(m.allocatableCpuMillicores)} CPU, ${fmtMem(m.allocatableMemoryMi)}`,
      );
      console.log(
        `   ${chalk.bold('Used:')}        ${fmtCpu(m.usedCpuMillicores)} CPU, ${fmtMem(m.usedMemoryMi)}`,
      );
      const freeColor =
        m.freeCpuMillicores < 250 || m.freeMemoryMi < 256
          ? chalk.red
          : chalk.green;
      const freeLabel = freeColor(
        `${fmtCpu(m.freeCpuMillicores)} CPU, ${fmtMem(m.freeMemoryMi)}`,
      );
      console.log(`   ${chalk.bold('Free:')}        ${freeLabel}`);
      if (m.monthlyCostEur) {
        console.log(`   ${chalk.bold('Cost/month:')}  €${m.monthlyCostEur}`);
      }
    } else {
      console.log(chalk.yellow('\n⚠️  Master node info unavailable.\n'));
    }

    if (plan.storage) {
      console.log(chalk.cyan('\n💾 Backing Volume\n'));
      console.log(`   ${chalk.bold('Volume ID:')}    ${plan.storage.volumeId}`);
      console.log(
        `   ${chalk.bold('Size:')}         ${plan.storage.sizeGb} GB`,
      );
      if (plan.storage.requestedGb !== undefined) {
        console.log(
          `   ${chalk.bold('PVC requested:')} ${plan.storage.requestedGb} GB`,
        );
      }
      if (plan.storage.pricePerGbMonthlyEur) {
        console.log(
          `   ${chalk.bold('Price/GB/mo:')}  €${plan.storage.pricePerGbMonthlyEur}`,
        );
      }
    }

    const filtered =
      direction === 'all'
        ? plan.candidates
        : plan.candidates.filter(
            (c) => c.direction === direction || c.direction === 'current',
          );
    const shown = filtered.slice(0, top);

    console.log(chalk.cyan('\n📋 Server-type Candidates\n'));
    if (shown.length === 0) {
      console.log(chalk.dim('   No candidates available.'));
    } else {
      const header = [
        pad(chalk.bold('TYPE'), 14),
        pad(chalk.bold('DIR'), 11),
        pad(chalk.bold('CPU'), 5),
        pad(chalk.bold('RAM'), 8),
        pad(chalk.bold('DISK'), 7),
        pad(chalk.bold('€/MONTH'), 10),
        pad(chalk.bold('Δ/MONTH'), 10),
      ].join('');
      console.log('   ' + header);
      for (const c of shown) {
        console.log('   ' + this.formatRow(c));
      }
      if (filtered.length > shown.length) {
        console.log(
          chalk.dim(
            `\n   … ${filtered.length - shown.length} more (use --top to extend)`,
          ),
        );
      }
    }

    console.log(chalk.dim('\n   Next steps:'));
    console.log(
      chalk.dim(
        '     • flui env scale-master --type <name>    (resize master)',
      ),
    );
    console.log(
      chalk.dim(
        '     • flui env storage-expand --size <NGiB>  (grow backing volume)',
      ),
    );
    console.log('');
  }

  private formatRow(c: CapacityCandidateDto): string {
    let dirColor: typeof chalk.cyan;
    if (c.direction === 'current') dirColor = chalk.cyan;
    else if (c.direction === 'upgrade') dirColor = chalk.yellow;
    else dirColor = chalk.green;
    const deltaNum = Number.parseFloat(c.monthlyDeltaEur);
    let deltaStr: string;
    if (Number.isNaN(deltaNum)) deltaStr = 'n/a';
    else if (deltaNum === 0) deltaStr = '0.00';
    else deltaStr = (deltaNum > 0 ? '+' : '') + deltaNum.toFixed(2);
    let deltaColor: (s: string) => string;
    if (Number.isNaN(deltaNum) || deltaNum === 0) deltaColor = (s) => s;
    else if (deltaNum > 0) deltaColor = chalk.yellow;
    else deltaColor = chalk.green;
    return [
      pad(c.name, 14),
      pad(dirColor(c.direction), 11),
      pad(String(c.cores), 5),
      pad(`${c.memoryGb} GB`, 8),
      pad(`${c.diskGb} GB`, 7),
      pad(`€${c.monthlyCostEur}`, 10),
      pad(deltaColor(deltaStr), 10),
    ].join('');
  }
}

function fmtCpu(millicores: number): string {
  return `${(millicores / 1000).toFixed(2)}`;
}

function fmtMem(mi: number): string {
  if (mi >= 1024) return `${(mi / 1024).toFixed(2)} GiB`;
  return `${mi} MiB`;
}

function pad(s: string, width: number): string {
  const visible = s.replaceAll(/\[[0-9;]*m/g, '');
  const gap = Math.max(1, width - visible.length);
  return s + ' '.repeat(gap);
}
