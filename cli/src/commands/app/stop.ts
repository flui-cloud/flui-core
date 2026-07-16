import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppStop extends Command {
  static readonly description = 'Stop an application (scale to 0 replicas)';

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
    const { args, flags } = await this.parse(AppStop);
    const spinner = ora(`Stopping "${args.name}"...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      await service.stop(app.id);

      spinner.succeed(`"${args.name}" stopped (0 replicas)`);
      const startCmd = chalk.cyan(`flui app start ${args.name}`);
      console.log(chalk.dim(`\n  Run ${startCmd} to bring it back up.\n`));
    } catch (error: any) {
      spinner.fail('Failed to stop application');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}
