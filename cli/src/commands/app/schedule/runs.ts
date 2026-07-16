import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  ScheduledJobRun,
} from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';

export default class AppScheduleRuns extends Command {
  static readonly description =
    'List the recent runs of a scheduled job with their status. History depth ' +
    'follows the CronJob retention limits.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app nightly-cleanup',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    name: Args.string({
      description: 'Schedule name',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  private colorStatus(status: ScheduledJobRun['status']): string {
    switch (status) {
      case 'Succeeded':
        return chalk.green(status);
      case 'Failed':
        return chalk.red(status);
      case 'Running':
        return chalk.cyan(status);
      default:
        return chalk.dim(status);
    }
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppScheduleRuns);
    const spinner = ora('Fetching runs...').start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const runs: ScheduledJobRun[] = await service.listScheduledJobRuns(
        app.id,
        args.name,
      );

      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(runs, null, 2));
        return;
      }

      if (runs.length === 0) {
        console.log(chalk.dim('  No runs yet.'));
        return;
      }

      console.log('');
      console.log(
        `  ${chalk.bold('JOB'.padEnd(40))} ${chalk.bold('STATUS'.padEnd(12))} ${chalk.bold('TRIGGER'.padEnd(9))} ${chalk.bold('STARTED')}`,
      );
      console.log('  ' + '─'.repeat(100));
      for (const r of runs) {
        const job = r.jobName.padEnd(40).slice(0, 40);
        const statusPad = ' '.repeat(Math.max(1, 12 - r.status.length));
        const status = this.colorStatus(r.status) + statusPad;
        const trigger = (r.manual ? 'manual' : 'cron').padEnd(9);
        const started = r.startTime ?? '—';
        console.log(`  ${job} ${status} ${trigger} ${started}`);
      }
      console.log('');
      console.log(chalk.dim(`  ${runs.length} run(s)`));
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to list runs');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
