import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppCrashes extends Command {
  static readonly description =
    'Show recent crash diagnoses for an application';

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
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppCrashes);
    const spinner = ora(`Fetching crash reports for "${args.name}"...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const diagnoses = await service.getCrashes(app.id);

      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(diagnoses, null, 2));
        return;
      }

      const open = diagnoses.filter((d) => !d.resolvedAt);
      const resolved = diagnoses.filter((d) => d.resolvedAt);

      if (diagnoses.length === 0) {
        console.log(chalk.green(`\n  No crash reports for "${args.name}".\n`));
        return;
      }

      console.log(chalk.cyan(`\n  Crash Reports — ${args.name}\n`));

      if (open.length > 0) {
        console.log(chalk.bold('  Active\n'));
        for (const d of open) this.printActiveDiagnosis(d);
      }

      if (resolved.length > 0) {
        console.log(
          chalk.dim(`  ${resolved.length} resolved crash(es) not shown.`),
        );
        console.log('');
      }

      console.log(
        chalk.dim(
          `  ${open.length} active, ${resolved.length} resolved — total ${diagnoses.length}`,
        ),
      );
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to fetch crash reports');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private printActiveDiagnosis(d: any): void {
    const icon =
      d.severity === 'critical' ? chalk.red('✖') : chalk.yellow('⚠');
    console.log(`  ${icon} ${chalk.bold(d.title)}`);
    console.log(`    ${chalk.dim('category:')}  ${d.category}`);
    console.log(`    ${chalk.dim('pod:')}       ${d.podName}`);
    console.log(
      `    ${chalk.dim('severity:')}  ${this.colorSeverity(d.severity)}`,
    );
    console.log(
      `    ${chalk.dim('detected:')}  ${new Date(d.createdAt).toLocaleString()}`,
    );
    if (d.explanation) {
      console.log(`    ${chalk.dim('reason:')}    ${d.explanation}`);
    }
    if (d.suggestedAction?.summary) {
      console.log(
        `    ${chalk.dim('action:')}    ${d.suggestedAction.summary}`,
      );
    }
    console.log('');
  }

  private colorSeverity(severity: string): string {
    switch (severity) {
      case 'critical':
        return chalk.red(severity);
      case 'warning':
        return chalk.yellow(severity);
      default:
        return chalk.dim(severity);
    }
  }
}
