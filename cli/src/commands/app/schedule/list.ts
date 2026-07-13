import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  ScheduledJob,
} from '../../../lib/services/cli-app.service';
import { resolveCluster } from '../../../lib/resolve-cluster';

export default class AppScheduleList extends Command {
  static readonly description =
    'List the scheduled jobs (cron) of an application. Each runs a command on ' +
    "the app's image + env on a cron schedule.";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app',
    '<%= config.bin %> <%= command.id %> my-app --output json',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Application name or slug',
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

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppScheduleList);
    const spinner = ora('Fetching schedules...').start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const items: ScheduledJob[] = await service.listScheduledJobs(app.id);

      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      if (items.length === 0) {
        console.log(chalk.dim('  No schedules found.'));
        return;
      }

      console.log('');
      console.log(
        `  ${chalk.bold('NAME'.padEnd(24))} ${chalk.bold('SCHEDULE'.padEnd(16))} ${chalk.bold('STATE'.padEnd(10))} ${chalk.bold('LAST RUN'.padEnd(22))} ${chalk.bold('COMMAND')}`,
      );
      console.log('  ' + '─'.repeat(110));
      for (const s of items) {
        const name = s.name.padEnd(24).slice(0, 24);
        const schedule = s.schedule.padEnd(16).slice(0, 16);
        const state = (
          s.enabled ? chalk.green('enabled') : chalk.yellow('suspended')
        ).padEnd(10);
        const last = (s.lastScheduleTime ?? '—').padEnd(22).slice(0, 22);
        const cmd =
          s.command.length > 40 ? s.command.slice(0, 37) + '...' : s.command;
        console.log(`  ${name} ${schedule} ${state} ${last} ${chalk.dim(cmd)}`);
      }
      console.log('');
      console.log(chalk.dim(`  ${items.length} schedule(s)`));
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to list schedules');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
