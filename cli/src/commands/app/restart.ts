import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppRestart extends Command {
  static readonly description = 'Trigger a rolling restart of an application';

  static readonly examples = ['<%= config.bin %> <%= command.id %> my-api'];

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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppRestart);
    const spinner = ora(`Restarting "${args.name}"...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      await service.restart(app.id);

      spinner.succeed(`Rolling restart triggered for "${args.name}"`);
      console.log(
        chalk.dim('\n  New pods will replace existing ones one by one.\n'),
      );
    } catch (error: any) {
      spinner.fail('Failed to restart application');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}
