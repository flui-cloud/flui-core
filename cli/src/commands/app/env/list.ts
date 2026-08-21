import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { describeVariables } from '../../../lib/variables-view';

/**
 * List an application's variables: plain values, sensitive keys that are set,
 * and sensitive keys still awaiting a person.
 *
 * No sensitive value is printed, because none is available to print — the API
 * answers with the mask. "Missing" is shown as a state, not an error: the exit
 * code is 0 whether or not something is still awaited.
 */
export default class AppEnvList extends Command {
  static readonly description =
    "List an application's variables — plain values, which sensitive keys are set, and which are still awaiting a value. Sensitive values are never shown.";

  static readonly examples = ['<%= config.bin %> <%= command.id %> my-api'];

  static readonly args = {
    app: Args.string({
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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppEnvList);

    const { id: clusterId } = await resolveClusterRef(flags.cluster);
    const service = await CliAppService.create(clusterId);
    const app = await service.getAppByName(args.app);
    const view = await service.getVariables(app.id);

    const rows = describeVariables(view);
    if (rows.length === 0) {
      this.log(chalk.dim(`\n  "${app.name}" has no variables.\n`));
      return;
    }

    this.log(chalk.bold(`\n  Variables of "${app.name}"\n`));
    const width = Math.max(...rows.map((r) => r.key.length));
    for (const row of rows) {
      const key = row.key.padEnd(width);
      if (row.state === 'plain') {
        this.log(`  ${key}  ${row.shown}`);
      } else if (row.state === 'set') {
        this.log(`  ${key}  ${chalk.dim(row.shown)}`);
      } else {
        this.log(`  ${key}  ${chalk.yellow(row.shown)}`);
      }
    }

    const missing = rows.filter((r) => r.state === 'missing');
    if (missing.length) {
      this.log(
        chalk.dim(
          `\n  ${missing.length} variable(s) awaiting a value. Deliver one with:\n` +
            `    flui app env set ${app.name} ${missing[0].key}\n`,
        ),
      );
    } else {
      this.log('');
    }
  }
}
