import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveCluster } from '../../../lib/resolve-cluster';
import { resolveGatewayRoute } from '../../../lib/gateway-utils';

export default class GatewayRoutesSync extends Command {
  static readonly description =
    "Bring a route's address record, route and certificate in line, and say what was done. " +
    'A certificate that failed is ordered again instead of waiting for the next automatic attempt.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app api.example.com',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    route: Args.string({
      description: 'Route host (or endpoint id)',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GatewayRoutesSync);
    const spinner = ora(`Syncing ${args.route}...`).start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const route = await resolveGatewayRoute(service, app.id, args.route);
      const synced = await service.reconcileGatewayRoute(
        app.id,
        route.endpointId,
      );
      spinner.succeed(`${route.host} synced`);
      for (const action of synced.sync.actions) {
        console.log(`  ${chalk.cyan('•')} ${action}`);
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Sync failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
