import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  ClusterGatewayRoute,
} from '../../../lib/services/cli-app.service';
import { resolveCluster } from '../../../lib/resolve-cluster';
import {
  policySummary,
  reconciliationLabel,
  tlsLabel,
} from '../../../lib/gateway-utils';

export default class GatewayRoutesList extends Command {
  static readonly description =
    'List gateway routes: host+path → app service with L7 policies ' +
    '(SSO auth, rate limit, IP allowlist). Pass an application for its ' +
    'routes, or omit it for the cluster-wide read-only view.';

  static readonly aliases = ['gateway:routes:ls'];

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app',
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> my-app --output json',
  ];

  static readonly args = {
    app: Args.string({
      description:
        'Application name or slug (omit for all routes on the cluster)',
      required: false,
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
    const { args, flags } = await this.parse(GatewayRoutesList);
    const spinner = ora('Fetching gateway routes...').start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);

      let items: ClusterGatewayRoute[];
      if (args.app) {
        const app = await service.getAppByName(args.app);
        items = await service.listGatewayRoutes(app.id);
      } else {
        items = await service.listClusterGatewayRoutes(clusterId);
      }

      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      if (items.length === 0) {
        console.log(chalk.dim('  No gateway routes found.'));
        return;
      }

      const showApp = !args.app;
      console.log('');
      const appCol = showApp ? `${chalk.bold('APP'.padEnd(18))} ` : '';
      console.log(
        `  ${chalk.bold('HOST'.padEnd(38))} ${chalk.bold('PATH'.padEnd(10))} ${appCol}${chalk.bold('TLS'.padEnd(10))} ${chalk.bold('STATUS'.padEnd(14))} ${chalk.bold('POLICIES')}`,
      );
      console.log('  ' + '─'.repeat(110));
      for (const r of items) {
        const host = r.host.padEnd(38).slice(0, 38);
        const path = r.path.padEnd(10).slice(0, 10);
        const app = showApp
          ? `${(r.applicationSlug ?? r.applicationName ?? '—').padEnd(18).slice(0, 18)} `
          : '';
        const tls = tlsLabel(r).padEnd(10 + 10);
        const status = reconciliationLabel(r.reconciliationStatus).padEnd(
          14 + 10,
        );
        console.log(
          `  ${host} ${path} ${app}${tls} ${status} ${policySummary(r)}`,
        );
      }
      console.log('');
      console.log(chalk.dim(`  ${items.length} route(s)`));
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to list gateway routes');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
