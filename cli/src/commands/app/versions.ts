import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppVersions extends Command {
  static readonly description =
    'List image versions available in the registry for an application, with deployment & release status';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
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
    limit: Flags.integer({ char: 'n', default: 20 }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppVersions);
    const spinner = ora(`Fetching versions for "${args.name}"...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const data = await service.listAvailableVersions(app.id);
      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(chalk.cyan(`\n  Versions — ${app.name}\n`));
      console.log(`  ${chalk.bold('Source:')}  ${data.sourceType}`);
      console.log(
        `  ${chalk.bold('Current:')} ${data.currentImageRef ?? chalk.dim('—')}`,
      );
      console.log('');

      const versions = data.versions.slice(0, flags.limit);
      if (versions.length === 0) {
        console.log(chalk.yellow('  No versions found.\n'));
        return;
      }

      console.log(
        chalk.dim(
          `  ${'TAG'.padEnd(20)} ${'DIGEST'.padEnd(15)} ${'CREATED'.padEnd(20)} ${'RELEASES'.padEnd(10)} STATE`,
        ),
      );
      console.log(chalk.dim('  ' + '─'.repeat(100)));
      for (const v of versions) {
        const tag = (v.tag ?? '').padEnd(20);
        const digest = (
          v.digest ? v.digest.replace('sha256:', '').slice(0, 12) : ''
        ).padEnd(15);
        const created = (
          v.createdAt ? new Date(v.createdAt).toLocaleString() : '-'
        ).padEnd(20);
        const rc = String(v.releaseCount).padEnd(10);
        const flags: string[] = [];
        if (v.isCurrentlyDeployed) flags.push(chalk.green('deployed'));
        if (v.isLatestRelease && !v.isCurrentlyDeployed)
          flags.push(chalk.yellow('latest-release'));
        if (v.lastRelease?.status === 'FAILED')
          flags.push(chalk.red('last-failed'));
        const state = flags.join(' ');
        console.log(`  ${tag} ${digest} ${created} ${rc} ${state}`);
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to fetch versions');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}
