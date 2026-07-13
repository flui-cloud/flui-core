import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveCluster } from '../../lib/resolve-cluster';
import {
  policySummary,
  reconciliationLabel,
  tlsLabel,
} from '../../lib/gateway-utils';

export default class GatewayStatus extends Command {
  static readonly description =
    'Reconciliation status of the gateway routes of an application ' +
    '(synced / reconciling / error per route).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app',
    '<%= config.bin %> <%= command.id %> my-app --output json',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GatewayStatus);
    const spinner = ora('Fetching gateway status...').start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const status = await service.getGatewayStatus(app.id);

      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      if (status.total === 0) {
        console.log(chalk.dim('  No gateway routes found.'));
        return;
      }

      console.log('');
      const counts = chalk.bold(`${status.synced}/${status.total}`);
      console.log(`  ${counts} route(s) synced`);
      console.log('');
      for (const r of status.routes) {
        const state = reconciliationLabel(r.reconciliationStatus);
        const pathSuffix = r.path === '/' ? '' : chalk.dim(r.path);
        console.log(
          `  ${state}  ${chalk.bold(r.host)}${pathSuffix}  ${tlsLabel(r)}  ${policySummary(r)}`,
        );
        if (r.errorMessage) {
          console.log(chalk.red(`      ${r.errorMessage}`));
        }
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to fetch gateway status');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
