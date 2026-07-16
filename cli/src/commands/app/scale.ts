import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppScale extends Command {
  static readonly description =
    'Scale an application to a desired replica count';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api --replicas 3',
    '<%= config.bin %> <%= command.id %> my-api --replicas 0',
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
    replicas: Flags.integer({
      char: 'r',
      description: 'Desired replica count (0 = stop all pods)',
      required: true,
      min: 0,
      max: 20,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppScale);
    const spinner = ora(
      `Scaling "${args.name}" to ${flags.replicas} replica(s)...`,
    ).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const runtime = await service.scale(app.id, flags.replicas);

      spinner.succeed(`Scaled "${args.name}" to ${flags.replicas} replica(s)`);

      const r = runtime.replicas;
      console.log('');
      console.log(
        `  ${chalk.bold('Desired:')}  ${r.desired ?? flags.replicas}`,
      );
      console.log(`  ${chalk.bold('Ready:')}    ${r.ready ?? 0}`);
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to scale application');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}
