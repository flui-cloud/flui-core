import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppStart extends Command {
  static readonly description = 'Start a stopped application';

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
    const { args, flags } = await this.parse(AppStart);
    const spinner = ora(`Starting "${args.name}"...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      await service.start(app.id);

      spinner.succeed(`"${args.name}" started`);
      console.log(chalk.dim('\n  Pods are coming up. Check status with:'));
      console.log(chalk.cyan(`  flui app status ${args.name}\n`));
    } catch (error: any) {
      spinner.fail('Failed to start application');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}
