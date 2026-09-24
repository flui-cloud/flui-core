import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  CrashDiagnosis,
} from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppCrash extends Command {
  static readonly description =
    'Show a single crash diagnosis. Use --apply to accept the change it proposes, or --dismiss to mark it resolved.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api 5d3f...',
    '<%= config.bin %> <%= command.id %> my-api 5d3f... --apply',
    '<%= config.bin %> <%= command.id %> my-api 5d3f... --dismiss',
    '<%= config.bin %> <%= command.id %> my-api 5d3f... --output json',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    id: Args.string({
      description: 'Crash diagnosis ID',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    apply: Flags.boolean({
      description:
        'Apply the change this diagnosis proposes (a higher memory limit after an out-of-memory kill). The application restarts.',
      default: false,
      exclusive: ['dismiss'],
    }),
    dismiss: Flags.boolean({
      description: 'Mark this crash diagnosis as resolved',
      default: false,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppCrash);
    const verb = verbOf(flags);
    const spinner = ora(`${verb} crash ${args.id}...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const d = await this.act(service, app.id, args.id, flags);

      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(d, null, 2));
        return;
      }

      if (flags.apply) {
        console.log(
          chalk.green(
            `\n  ✔ Applied: ${d.suggestedAction?.message ?? 'the proposed change'} The application restarts with it.\n`,
          ),
        );
        return;
      }

      if (flags.dismiss) {
        console.log(chalk.green(`\n  ✔ Crash ${d.id} marked as resolved.\n`));
        return;
      }

      console.log(chalk.cyan(`\n  Crash ${d.id}\n`));
      console.log(`  ${chalk.dim('title:')}      ${d.title}`);
      console.log(`  ${chalk.dim('category:')}   ${d.category}`);
      console.log(
        `  ${chalk.dim('severity:')}   ${this.colorSeverity(d.severity)}`,
      );
      console.log(`  ${chalk.dim('pod:')}        ${d.podName}`);
      if (d.containerName) {
        console.log(`  ${chalk.dim('container:')}  ${d.containerName}`);
      }
      console.log(
        `  ${chalk.dim('detected:')}   ${new Date(d.createdAt).toLocaleString()}`,
      );
      console.log(
        `  ${chalk.dim('resolved:')}   ${d.resolvedAt ? new Date(d.resolvedAt).toLocaleString() : chalk.yellow('open')}`,
      );
      if (d.explanation) {
        console.log(`\n  ${chalk.bold('Reason')}`);
        console.log(`  ${d.explanation}`);
      }
      const action = d.suggestedAction as {
        type?: string;
        message?: string;
      } | null;
      if (action?.message) {
        console.log(`\n  ${chalk.bold('Suggested action')}`);
        console.log(`  ${action.message}`);
        if (action.type === 'resources' && !d.resolvedAt) {
          console.log(
            chalk.dim(
              `  Apply it: flui app crash ${args.name} ${d.id} --apply`,
            ),
          );
        }
      }
      console.log('');
    } catch (error: any) {
      spinner.fail(`${verb} failed`);
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private act(
    service: CliAppService,
    appId: string,
    id: string,
    flags: { apply: boolean; dismiss: boolean },
  ): Promise<CrashDiagnosis> {
    if (flags.apply) return service.applyCrash(appId, id);
    if (flags.dismiss) return service.dismissCrash(appId, id);
    return service.getCrash(appId, id);
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

function verbOf(flags: { apply: boolean; dismiss: boolean }): string {
  if (flags.apply) return 'Applying';
  if (flags.dismiss) return 'Dismissing';
  return 'Fetching';
}
