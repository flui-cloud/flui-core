import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  ScheduledJobRun,
} from '../../../lib/services/cli-app.service';
import { resolveCluster } from '../../../lib/resolve-cluster';

export default class AppScheduleLogs extends Command {
  static readonly description =
    'Show the logs of a scheduled-job run. Defaults to the most recent run; ' +
    'use --run to target a specific one (see `flui app schedule runs`).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app nightly-cleanup',
    '<%= config.bin %> <%= command.id %> my-app nightly-cleanup --run my-app-nightly-cleanup-28912345',
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
    run: Flags.string({
      char: 'r',
      description: 'Specific run (Job) name. Default: most recent run',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppScheduleLogs);
    const spinner = ora('Fetching run logs...').start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);

      let jobName = flags.run;
      if (!jobName) {
        const runs: ScheduledJobRun[] = await service.listScheduledJobRuns(
          app.id,
          args.name,
        );
        if (runs.length === 0) {
          spinner.stop();
          console.log(chalk.dim('  No runs yet for this schedule.'));
          return;
        }
        jobName = runs[0].jobName;
      }

      const { logs } = await service.getScheduledJobRunLogs(
        app.id,
        args.name,
        jobName,
      );
      spinner.stop();

      console.log(chalk.dim(`\n  Run: ${jobName}\n`));
      if (!logs.trim()) {
        console.log(
          chalk.dim('  (no logs — the run pod may be gone or empty)'),
        );
      } else {
        console.log(logs);
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to fetch run logs');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
