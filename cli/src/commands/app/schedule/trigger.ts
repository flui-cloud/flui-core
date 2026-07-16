import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';

export default class AppScheduleTrigger extends Command {
  static readonly description =
    'Trigger a scheduled job now, independently of its cron timing. Creates a ' +
    'one-off run from the schedule.';

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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppScheduleTrigger);
    const spinner = ora(`Triggering "${args.name}"...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const { jobName } = await service.triggerScheduledJob(app.id, args.name);
      spinner.succeed(`Run started: ${jobName}`);
      console.log('');
      console.log(
        chalk.dim(
          `  Follow with: flui app schedule runs ${args.app} ${args.name}`,
        ),
      );
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to trigger schedule');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
