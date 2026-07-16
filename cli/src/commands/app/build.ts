import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  AppBuild as AppBuildEntity,
} from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

const TERMINAL: ReadonlySet<AppBuildEntity['status']> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export default class AppBuild extends Command {
  static readonly description =
    'Inspect or refresh the latest build for an application. ' +
    'Use --watch to follow the status until terminal.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --watch',
    '<%= config.bin %> <%= command.id %> my-api --refresh',
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
      options: ['text', 'json'],
      default: 'text',
    }),
    refresh: Flags.boolean({
      description:
        'Force the backend to re-poll GitHub Actions for the latest build now',
    }),
    watch: Flags.boolean({
      char: 'w',
      description:
        'Poll until the latest build reaches a terminal status (COMPLETED / FAILED / CANCELLED)',
    }),
    interval: Flags.integer({
      description: 'Polling interval in seconds (with --watch)',
      default: 5,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppBuild);
    const spinner = ora(`Fetching latest build for "${args.name}"...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);

      let build = await service.getLatestBuild(app.id);
      if (!build) {
        spinner.stop();
        console.log(chalk.yellow(`\n  No builds found for ${app.name}.\n`));
        return;
      }

      if (flags.refresh) {
        spinner.text = 'Refreshing from provider...';
        build = await service.refreshBuild(build.id);
      }

      if (!flags.watch) {
        spinner.stop();
        if (flags.output === 'json') {
          console.log(JSON.stringify(build, null, 2));
        } else {
          this.printBuild(app.name, build);
        }
        return;
      }

      // Watch mode
      while (!TERMINAL.has(build.status)) {
        spinner.text = `Build ${build.status.toLowerCase()}... (${new Date().toLocaleTimeString()})`;
        await sleep(flags.interval * 1000);
        try {
          build = await service.refreshBuild(build.id);
        } catch {
          // Fallback to plain GET if refresh fails transiently
          build = await service.getBuild(build.id);
        }
      }
      spinner.stop();
      if (flags.output === 'json') {
        console.log(JSON.stringify(build, null, 2));
      } else {
        this.printBuild(app.name, build);
      }
      if (build.status !== 'COMPLETED') this.exit(1);
    } catch (error: any) {
      spinner.fail('Failed to fetch build');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private printBuild(appName: string, b: AppBuildEntity): void {
    console.log(chalk.cyan(`\n  Latest build — ${appName}\n`));
    console.log(`  ${chalk.bold('ID:')}        ${b.id}`);
    console.log(`  ${chalk.bold('Status:')}    ${colorStatus(b.status)}`);
    console.log(`  ${chalk.bold('Provider:')}  ${b.provider}`);
    console.log(`  ${chalk.bold('Branch:')}    ${b.branch}`);
    if (b.commitSha)
      console.log(`  ${chalk.bold('Commit:')}    ${b.commitSha.slice(0, 12)}`);
    if (b.imageRef) console.log(`  ${chalk.bold('Image:')}     ${b.imageRef}`);
    if (b.externalUrl)
      console.log(`  ${chalk.bold('Run URL:')}   ${chalk.dim(b.externalUrl)}`);
    if (b.errorMessage)
      console.log(`  ${chalk.bold('Error:')}     ${chalk.red(b.errorMessage)}`);
    console.log('');
  }
}

function colorStatus(s: AppBuildEntity['status']): string {
  if (s === 'COMPLETED') return chalk.green(s);
  if (s === 'FAILED' || s === 'CANCELLED') return chalk.red(s);
  if (s === 'PENDING') return chalk.dim(s);
  return chalk.blue(s);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
