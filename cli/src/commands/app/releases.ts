import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  ApplicationRelease,
} from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppReleases extends Command {
  static readonly description =
    'List recent releases (deploy/rollback operations) for an application';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --current',
    '<%= config.bin %> <%= command.id %> my-api --output json',
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
    current: Flags.boolean({
      description: 'Only show the current (most recent) release',
    }),
    limit: Flags.integer({ char: 'n', default: 10 }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppReleases);
    const spinner = ora(`Fetching releases for "${args.name}"...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);

      if (flags.current) {
        const release = await service.getCurrentRelease(app.id);
        spinner.stop();
        if (flags.output === 'json') {
          console.log(JSON.stringify(release, null, 2));
          return;
        }
        if (!release) {
          console.log(chalk.yellow(`\n  No releases for ${app.name}.\n`));
          return;
        }
        printRelease(app.name, release, true);
        return;
      }

      const releases = (await service.listReleases(app.id)).slice(
        0,
        flags.limit,
      );
      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(releases, null, 2));
        return;
      }

      if (releases.length === 0) {
        console.log(chalk.yellow(`\n  No releases for ${app.name}.\n`));
        return;
      }

      console.log(chalk.cyan(`\n  Releases — ${app.name}\n`));
      console.log(
        chalk.dim(
          `  ${'STATUS'.padEnd(12)} ${'IMAGE'.padEnd(48)} ${'STARTED'.padEnd(20)} REASON`,
        ),
      );
      console.log(chalk.dim('  ' + '─'.repeat(110)));
      for (const r of releases) {
        const status = colorStatus(r.status).padEnd(21);
        const image = (r.imageRef ?? '').padEnd(48);
        const started = new Date(r.startedAt).toLocaleString().padEnd(20);
        const reason = r.failureReason
          ? chalk.red(r.failureReason.slice(0, 60))
          : '';
        console.log(`  ${status} ${image} ${started} ${reason}`);
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to fetch releases');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}

function printRelease(
  appName: string,
  r: ApplicationRelease,
  current: boolean,
): void {
  const title = current
    ? `Current release — ${appName}`
    : `Release — ${appName}`;
  console.log(chalk.cyan(`\n  ${title}\n`));
  console.log(`  ${chalk.bold('Status:')}        ${colorStatus(r.status)}`);
  console.log(`  ${chalk.bold('Operation:')}     ${r.operationId}`);
  if (r.imageRef)
    console.log(`  ${chalk.bold('Image:')}         ${r.imageRef}`);
  if (r.previousImageRef)
    console.log(
      `  ${chalk.bold('Previous:')}      ${chalk.dim(r.previousImageRef)}`,
    );
  if (r.buildId) console.log(`  ${chalk.bold('Build:')}         ${r.buildId}`);
  console.log(
    `  ${chalk.bold('Started:')}       ${new Date(r.startedAt).toLocaleString()}`,
  );
  if (r.completedAt)
    console.log(
      `  ${chalk.bold('Completed:')}     ${new Date(r.completedAt).toLocaleString()}`,
    );
  if (r.failureReason)
    console.log(
      `  ${chalk.bold('Reason:')}        ${chalk.red(r.failureReason)}`,
    );
  console.log('');
}

function colorStatus(s: ApplicationRelease['status']): string {
  if (s === 'SUCCEEDED') return chalk.green(s);
  if (s === 'FAILED') return chalk.red(s);
  if (s === 'ROLLED_BACK') return chalk.yellow(s);
  return chalk.blue(s);
}
