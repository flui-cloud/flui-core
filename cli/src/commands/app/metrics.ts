import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { formatBytes } from '../../lib/format-bytes';

export default class AppMetrics extends Command {
  static readonly description =
    'Show instant Prometheus metrics (CPU/mem/network/replicas) for an application';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --output json',
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
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppMetrics);
    const spinner = ora(`Fetching metrics for "${args.name}"...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const res = await service.getMetrics(app.id);
      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      const m = res.metrics;
      console.log(chalk.cyan(`\n  Metrics — ${res.app_name}`));
      console.log(
        chalk.dim(
          `  namespace=${res.namespace}  queried=${new Date(res.queried_at).toLocaleString()}\n`,
        ),
      );

      console.log(chalk.bold('  CPU'));
      console.log(
        `    usage      ${this.fmtCores(m.cpu.usage_cores)}  /  req ${this.fmtCores(m.cpu.requests_cores)}  /  lim ${this.fmtCores(m.cpu.limits_cores)}`,
      );
      console.log(
        `    utilization ${this.fmtPct(m.cpu.utilization_percent)}\n`,
      );

      console.log(chalk.bold('  Memory'));
      console.log(
        `    usage      ${this.fmtBytes(m.memory.usage_bytes)}  /  req ${this.fmtBytes(m.memory.requests_bytes)}  /  lim ${this.fmtBytes(m.memory.limits_bytes)}`,
      );
      console.log(
        `    utilization ${this.fmtPct(m.memory.utilization_percent)}\n`,
      );

      console.log(chalk.bold('  Network'));
      console.log(
        `    rx         ${this.fmtRate(m.network.receive_bytes_rate)}`,
      );
      console.log(
        `    tx         ${this.fmtRate(m.network.transmit_bytes_rate)}\n`,
      );

      console.log(chalk.bold('  Replicas'));
      const s = m.status;
      console.log(
        `    desired=${s.replicas_desired ?? '-'}  ready=${s.replicas_ready ?? '-'}  unavailable=${s.replicas_unavailable ?? '-'}  up=${s.up ?? '-'}`,
      );
      console.log(
        `    restarts   total=${s.restart_total ?? '-'}  rate(1h)=${s.restart_rate_1h ?? '-'}\n`,
      );

      if (m.pods.length > 0) {
        console.log(chalk.bold('  Pods'));
        for (const p of m.pods) {
          console.log(`    ${p.phase.padEnd(10)} ${p.count}`);
        }
        console.log('');
      }
    } catch (error: any) {
      spinner.fail('Failed to fetch metrics');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private fmtCores(v: number | null): string {
    if (v === null || v === undefined) return chalk.dim('-');
    return `${v.toFixed(3)} cores`;
  }

  private fmtBytes(v: number | null): string {
    if (v === null || v === undefined) return chalk.dim('-');
    return formatBytes(v);
  }

  private fmtRate(v: number | null): string {
    if (v === null || v === undefined) return chalk.dim('-');
    return `${formatBytes(v)}/s`;
  }

  private fmtPct(v: number | null): string {
    if (v === null || v === undefined) return chalk.dim('-');
    return `${v.toFixed(1)}%`;
  }
}
