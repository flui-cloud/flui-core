import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppTraffic extends Command {
  static readonly description =
    'Show HTTP traffic (rate, status codes, latency) for an application, measured at the ingress';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --window 1h',
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
    window: Flags.string({
      char: 'w',
      description:
        'Rate window (e.g. 5m, 1h). Longer is smoother on low traffic',
      default: '5m',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppTraffic);
    const spinner = ora(`Fetching traffic for "${args.name}"...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const res = await service.getTraffic(app.id, flags.window);
      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(chalk.cyan(`\n  Traffic — ${res.app_name}`));
      console.log(
        chalk.dim(
          `  namespace=${res.namespace}  window=${res.window}  queried=${new Date(res.queried_at).toLocaleString()}\n`,
        ),
      );

      if (!res.is_routable) {
        console.log(
          chalk.yellow(
            '  This application is not exposed through the ingress, so it has no edge traffic.\n',
          ),
        );
        return;
      }

      const t = res.traffic;

      console.log(chalk.bold('  Requests'));
      console.log(
        `    rate       ${this.fmtRate(t.rate.requests_per_second)}   ${chalk.dim(
          `~${t.rate.requests_in_window ?? '-'} in ${res.window}`,
        )}`,
      );
      console.log(
        `    2xx ${this.fmtRate(t.status.rate_2xx)}   3xx ${this.fmtRate(t.status.rate_3xx)}   ` +
          `4xx ${this.fmtRate(t.status.rate_4xx)}   5xx ${this.fmtRate(t.status.rate_5xx)}`,
      );
      console.log(
        `    errors     server ${this.fmtErr(t.status.server_error_percent)}   client ${this.fmtPct(t.status.client_error_percent)}\n`,
      );

      console.log(chalk.bold('  Latency'));
      console.log(
        `    mean       ${this.fmtMs(t.latency.mean_seconds)}   ${chalk.dim('(measured)')}`,
      );
      console.log(
        `    p50 ${this.fmtMs(t.latency.p50_seconds)}   p90 ${this.fmtMs(t.latency.p90_seconds)}   ` +
          `p95 ${this.fmtMs(t.latency.p95_seconds)}   p99 ${this.fmtMs(t.latency.p99_seconds)}`,
      );
      if (t.latency.estimates_are_coarse) {
        console.log(
          chalk.yellow(
            `    percentiles are estimates — the histogram only has boundaries at ` +
              `${t.latency.bucket_boundaries_seconds.join('/')}s, too coarse to resolve this app`,
          ),
        );
      }
      console.log('');

      if (t.by_method.length > 0) {
        console.log(chalk.bold('  By method'));
        for (const entry of t.by_method) {
          console.log(
            `    ${entry.method.padEnd(8)} ${this.fmtRate(entry.requests_per_second)}`,
          );
        }
        console.log('');
      }

      if (t.by_status_code.length > 0) {
        console.log(chalk.bold('  By status code'));
        for (const entry of t.by_status_code) {
          console.log(
            `    ${this.colorCode(entry.code)} ${this.fmtRate(entry.requests_per_second)}`,
          );
        }
        console.log('');
      }
    } catch (error: any) {
      spinner.fail('Failed to fetch traffic');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private fmtRate(v: number | null): string {
    if (v === null || v === undefined) return chalk.dim('-');
    return `${v.toFixed(3)} req/s`;
  }

  private fmtMs(v: number | null): string {
    if (v === null || v === undefined) return chalk.dim('-');
    return v < 1 ? `${(v * 1000).toFixed(0)}ms` : `${v.toFixed(2)}s`;
  }

  private fmtPct(v: number | null): string {
    if (v === null || v === undefined) return chalk.dim('-');
    return `${v.toFixed(2)}%`;
  }

  private fmtErr(v: number | null): string {
    if (v === null || v === undefined) return chalk.dim('-');
    const text = `${v.toFixed(2)}%`;
    if (v >= 5) return chalk.red(text);
    if (v > 0) return chalk.yellow(text);
    return chalk.green(text);
  }

  private colorCode(code: string): string {
    const padded = code.padEnd(8);
    if (/^5\d{2}$/.test(code)) return chalk.red(padded);
    if (/^4\d{2}$/.test(code)) return chalk.yellow(padded);
    if (/^2\d{2}$/.test(code)) return chalk.green(padded);
    return chalk.dim(padded);
  }
}
