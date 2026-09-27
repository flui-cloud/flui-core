import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppScale extends Command {
  static readonly description =
    'Set how many replicas an application runs: a fixed count (--replicas), or a range the count follows with the CPU load (--min/--max, optionally --cpu). --no-autoscale goes back to a fixed count. Replicas that find no room wait for a node, which is what makes the scaling group buy one. For an app deployed from flui.yaml the range is its `deploy.scaling`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api --replicas 3',
    '<%= config.bin %> <%= command.id %> my-api --replicas 0',
    '<%= config.bin %> <%= command.id %> my-api --min 1 --max 4 --cpu 70',
    '<%= config.bin %> <%= command.id %> my-api --no-autoscale',
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
      min: 0,
      max: 20,
      exclusive: ['min', 'max', 'cpu', 'autoscale'],
    }),
    min: Flags.integer({
      description: 'Fewest replicas while the count follows the load',
      min: 1,
      max: 20,
    }),
    max: Flags.integer({
      description: 'Most replicas while the count follows the load',
      min: 1,
      max: 20,
    }),
    cpu: Flags.integer({
      description:
        'CPU use per replica, in percent of what it reserves, above which one is added',
      min: 10,
      max: 95,
    }),
    autoscale: Flags.boolean({
      description:
        'Let the count follow the load (--no-autoscale: back to a fixed count)',
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppScale);
    if (flags.replicas === undefined) {
      await this.autoscale(args.name, flags);
      return;
    }
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
      if (runtime.waitingForRoom) {
        console.log(chalk.yellow(`  ${runtime.waitingForRoom.says}`));
      }
      console.log(
        chalk.dim(`  Follow it with \`flui app status ${args.name}\`.`),
      );
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to scale application');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private async autoscale(
    name: string,
    flags: {
      cluster?: string;
      min?: number;
      max?: number;
      cpu?: number;
      autoscale?: boolean;
    },
  ): Promise<void> {
    const enabled =
      flags.autoscale ??
      (flags.min !== undefined ||
        flags.max !== undefined ||
        flags.cpu !== undefined);
    if (!enabled && flags.autoscale === undefined) {
      this.error(
        'Pass --replicas, or --min/--max for a range, or --no-autoscale.',
      );
    }
    const spinner = ora(`Updating replica autoscaling of "${name}"...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(name);
      const result = await service.autoscale(app.id, {
        enabled,
        min: flags.min,
        max: flags.max,
        targetCPU: flags.cpu,
      });
      spinner.succeed(
        result.enabled
          ? `"${name}" runs ${result.min} to ${result.max} replicas, adding one above ${result.targetCPU}% CPU`
          : `"${name}" runs a fixed number of replicas`,
      );
      if (result.rangeFrom === 'manifest') {
        console.log(
          chalk.dim('  The range comes from flui.yaml (deploy.scaling).'),
        );
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Replica autoscaling not changed');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}
