import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { AppRuntime, CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppResources extends Command {
  static readonly description =
    'Show or change how much CPU and memory an application may use. Without a change flag it shows the current values. A container is stopped for crossing its memory limit, never its request — the request is what a machine keeps free for it. Changing either restarts the application.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --memory-limit 1Gi',
    '<%= config.bin %> <%= command.id %> my-api --cpu-request 250m --memory-request 256Mi',
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
    'cpu-request': Flags.string({
      description: 'CPU a machine keeps free for it, e.g. 250m or 0.5',
    }),
    'cpu-limit': Flags.string({
      description: 'Most CPU it may use, e.g. 500m or 1',
    }),
    'memory-request': Flags.string({
      description: 'Memory a machine keeps free for it, e.g. 256Mi',
    }),
    'memory-limit': Flags.string({
      description:
        'Most memory it may use before it is stopped, e.g. 512Mi or 1Gi',
    }),
    container: Flags.string({
      description: 'Container to change (default: the first one)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppResources);
    const requests = pick(flags['cpu-request'], flags['memory-request']);
    const limits = pick(flags['cpu-limit'], flags['memory-limit']);
    const changing = Boolean(requests || limits);

    const spinner = ora(
      changing
        ? `Changing resources of "${args.name}"...`
        : `Reading resources of "${args.name}"...`,
    ).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const runtime = changing
        ? await service.setResources(app.id, {
            requests,
            limits,
            containerName: flags.container,
          })
        : await service.getRuntime(app.id);

      if (changing) {
        spinner.succeed(
          `Resources of "${args.name}" changed — the application restarts with them`,
        );
      } else {
        spinner.stop();
      }

      if (flags.output === 'json') {
        console.log(JSON.stringify(runtime.containers, null, 2));
        return;
      }
      print(runtime);
    } catch (error: any) {
      spinner.fail(
        changing ? 'Failed to change resources' : 'Failed to read resources',
      );
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}

function pick(
  cpu: string | undefined,
  memory: string | undefined,
): { cpu?: string; memory?: string } | undefined {
  if (cpu === undefined && memory === undefined) return undefined;
  return {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory }),
  };
}

function print(runtime: AppRuntime): void {
  console.log('');
  for (const c of runtime.containers) {
    console.log(`  ${chalk.bold(c.name)}`);
    console.log(
      `    ${chalk.dim('cpu:')}     request ${c.requests.cpu ?? '—'} · limit ${c.limits.cpu ?? '—'}`,
    );
    console.log(
      `    ${chalk.dim('memory:')}  request ${c.requests.memory ?? '—'} · limit ${c.limits.memory ?? '—'}`,
    );
    if (c.usage?.cpu || c.usage?.memory) {
      console.log(
        `    ${chalk.dim('in use:')}  cpu ${c.usage.cpu ?? '—'} · memory ${c.usage.memory ?? '—'}`,
      );
    }
  }
  console.log('');
}
