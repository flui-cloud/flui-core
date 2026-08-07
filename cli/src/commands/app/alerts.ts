import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService, AppAlert } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppAlerts extends Command {
  static readonly description =
    'Show alerts for an application — one row per episode, newest first';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --firing',
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
    firing: Flags.boolean({
      description: 'Only alerts still firing',
      default: false,
    }),
    limit: Flags.integer({
      char: 'n',
      description: 'How many to show',
      default: 20,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppAlerts);
    const spinner = ora(`Fetching alerts for "${args.name}"...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const res = await service.getAlerts(app.id, {
        status: flags.firing ? 'firing' : undefined,
        limit: flags.limit,
      });
      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(chalk.cyan(`\n  Alerts — ${app.name ?? args.name}`));
      console.log(
        chalk.dim(
          `  firing=${res.firing}  shown=${res.alerts.length}  ` +
            `queried=${new Date(res.queried_at).toLocaleString()}\n`,
        ),
      );

      if (res.alerts.length === 0) {
        console.log(
          chalk.green(
            flags.firing
              ? '  Nothing firing.\n'
              : '  No alerts on record for this application.\n',
          ),
        );
        return;
      }

      for (const alert of res.alerts) {
        this.printAlert(alert);
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to fetch alerts');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private printAlert(alert: AppAlert): void {
    const badge = this.statusBadge(alert);
    const name = chalk.bold(alert.alertname);
    console.log(`  ${badge} ${name}  ${this.severityLabel(alert.severity)}`);
    console.log(chalk.dim(`      ${alert.summary}`));
    console.log(chalk.dim(`      ${this.timing(alert)}`));
  }

  private statusBadge(alert: AppAlert): string {
    if (alert.status === 'firing') return chalk.red('● firing  ');
    if (alert.resolved_by === 'timeout') {
      // The resolve notification never arrived; the end time is a guess, so say so.
      return chalk.yellow('○ resolved*');
    }
    return chalk.green('○ resolved ');
  }

  private severityLabel(severity: string): string {
    if (severity === 'critical') return chalk.red(`[${severity}]`);
    if (severity === 'warning') return chalk.yellow(`[${severity}]`);
    return chalk.dim(`[${severity}]`);
  }

  private timing(alert: AppAlert): string {
    const started = new Date(alert.starts_at).toLocaleString();
    if (alert.status === 'firing') {
      return `started ${started}`;
    }
    const ended = alert.ends_at
      ? new Date(alert.ends_at).toLocaleString()
      : '?';
    const suffix =
      alert.resolved_by === 'timeout'
        ? '  (* stopped reporting; end time approximate)'
        : '';
    return `${started} → ${ended}${suffix}`;
  }
}
