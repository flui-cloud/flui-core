import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService, AppBuild } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppBuilds extends Command {
  static readonly description = 'List recent builds for an application';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --output json',
    '<%= config.bin %> <%= command.id %> my-api --limit 5',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({ char: 'c' }),
    output: Flags.string({
      char: 'o',
      options: ['table', 'json'],
      default: 'table',
    }),
    limit: Flags.integer({ char: 'n', default: 10 }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppBuilds);
    const spinner = ora(`Fetching builds for "${args.name}"...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const builds = (await service.listBuilds(app.id)).slice(0, flags.limit);
      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(builds, null, 2));
        return;
      }

      if (builds.length === 0) {
        console.log(chalk.yellow(`\n  No builds found for ${app.name}.\n`));
        return;
      }

      console.log(chalk.cyan(`\n  Builds for ${app.name}\n`));
      console.log(
        chalk.dim(
          `  ${'STATUS'.padEnd(11)} ${'PROVIDER'.padEnd(16)} ${'BRANCH'.padEnd(14)} ${'COMMIT'.padEnd(10)} ${'STARTED'.padEnd(20)} URL`,
        ),
      );
      console.log(chalk.dim('  ' + '─'.repeat(100)));

      for (const b of builds) {
        const status = colorBuildStatus(b.status ?? 'PENDING').padEnd(20);
        const provider = (b.provider ?? '-').padEnd(16);
        const branch = (b.branch ?? '-').padEnd(14);
        const commit = ((b.commitSha ?? '').slice(0, 7) || '-').padEnd(10);
        const started = b.startedAt
          ? new Date(b.startedAt).toLocaleString().padEnd(20)
          : chalk.dim('-'.padEnd(20));
        const url = b.externalUrl ?? '';
        console.log(
          `  ${status} ${provider} ${branch} ${commit} ${started} ${chalk.dim(url)}`,
        );
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to fetch builds');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}

function colorBuildStatus(s: AppBuild['status']): string {
  if (s === 'COMPLETED') return chalk.green(s);
  if (s === 'FAILED' || s === 'CANCELLED') return chalk.red(s);
  if (s === 'PENDING') return chalk.dim(s);
  return chalk.blue(s);
}
