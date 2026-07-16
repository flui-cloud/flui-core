import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppLogs extends Command {
  static readonly description = 'Fetch logs for an application';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --level error',
    '<%= config.bin %> <%= command.id %> my-api --tail 500',
    '<%= config.bin %> <%= command.id %> my-api --search "connection refused"',
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
    level: Flags.string({
      char: 'l',
      description: 'Filter by log level',
      options: ['error', 'warn', 'info', 'debug'],
    }),
    tail: Flags.integer({
      char: 'n',
      description: 'Number of lines to return',
      default: 100,
    }),
    search: Flags.string({
      char: 's',
      description: 'Full-text search query',
    }),
    namespace: Flags.string({
      description: 'Kubernetes namespace (optional, auto-detected from app)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppLogs);
    const spinner = ora(`Fetching logs for "${args.name}"...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);

      const result = await service.getLogs({
        app: app.slug || app.name,
        namespace: flags.namespace,
        level: flags.level,
        tail: flags.tail,
        search: flags.search,
      });

      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.logs.length === 0) {
        const levelHint = flags.level ? ` at level "${flags.level}"` : '';
        console.log(
          chalk.yellow(`\n  No logs found for "${args.name}"${levelHint}.\n`),
        );
        return;
      }

      const header = flags.level
        ? chalk.cyan(
            `\n  Logs for ${args.name} (level: ${flags.level}) — ${result.count} lines\n`,
          )
        : chalk.cyan(`\n  Logs for ${args.name} — ${result.count} lines\n`);
      console.log(header);

      for (const entry of result.logs) {
        const time = chalk.dim(
          new Date(entry.timestamp)
            .toISOString()
            .replace('T', ' ')
            .slice(0, 23),
        );
        const level = this.colorLevel(entry.level);
        const pod = entry.pod
          ? chalk.dim(`[${entry.pod.split('-').slice(-2).join('-')}]`)
          : '';
        console.log(`  ${time} ${level} ${pod} ${entry.message}`);
      }

      console.log('');
      console.log(chalk.dim(`  Queried at: ${result.queried_at}`));
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to fetch logs');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private colorLevel(level?: string): string {
    if (!level) return '     ';
    const padded = level.toUpperCase().padEnd(5);
    switch (level.toLowerCase()) {
      case 'error':
        return chalk.red(padded);
      case 'warn':
        return chalk.yellow(padded);
      case 'info':
        return chalk.blue(padded);
      case 'debug':
        return chalk.dim(padded);
      default:
        return chalk.white(padded);
    }
  }
}
