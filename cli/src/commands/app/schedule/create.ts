import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  CronConcurrencyPolicy,
} from '../../../lib/services/cli-app.service';
import { resolveCluster } from '../../../lib/resolve-cluster';

export default class AppScheduleCreate extends Command {
  static readonly description =
    'Create a scheduled job (cron) on an application. The job runs the given ' +
    "command on the app's image + env, on the cron schedule. Overlapping runs " +
    'are skipped by default (concurrency=Forbid).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app --name nightly-cleanup --schedule "0 3 * * *" --command "node dist/cleanup.js"',
    '<%= config.bin %> <%= command.id %> my-app -n report -s "*/15 * * * *" -x "php artisan report:run" --timezone Europe/Rome',
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
    name: Flags.string({
      char: 'n',
      description: 'Schedule name (lowercase alphanumeric + dashes)',
      required: true,
    }),
    schedule: Flags.string({
      char: 's',
      description: 'Cron expression (5 fields), e.g. "0 3 * * *"',
      required: true,
    }),
    command: Flags.string({
      char: 'x',
      description: 'Shell command to run (executed via /bin/sh -c)',
      required: true,
    }),
    timezone: Flags.string({
      char: 't',
      description: 'IANA timezone (e.g. Europe/Rome). Default: cluster time',
    }),
    concurrency: Flags.string({
      description: 'Overlap policy',
      options: ['Allow', 'Forbid', 'Replace'],
      default: 'Forbid',
    }),
    disabled: Flags.boolean({
      description: 'Create the schedule suspended (not running)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppScheduleCreate);
    const spinner = ora(`Creating schedule "${flags.name}"...`).start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const job = await service.createScheduledJob(app.id, {
        name: flags.name,
        schedule: flags.schedule,
        command: flags.command,
        timezone: flags.timezone,
        concurrencyPolicy: flags.concurrency as CronConcurrencyPolicy,
        enabled: !flags.disabled,
      });

      spinner.succeed(`Schedule "${job.name}" created`);
      console.log('');
      console.log(`  ${chalk.bold('Schedule:')} ${job.schedule}`);
      console.log(`  ${chalk.bold('Command:')}  ${job.command}`);
      if (job.timezone) {
        console.log(`  ${chalk.bold('Timezone:')} ${job.timezone}`);
      }
      console.log(`  ${chalk.bold('Overlap:')}  ${job.concurrencyPolicy}`);
      console.log(
        `  ${chalk.bold('State:')}    ${job.enabled ? chalk.green('enabled') : chalk.yellow('suspended')}`,
      );
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to create schedule');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
