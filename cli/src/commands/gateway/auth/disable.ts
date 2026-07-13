import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveCluster } from '../../../lib/resolve-cluster';
import {
  printRouteDetail,
  resolveGatewayRoute,
} from '../../../lib/gateway-utils';

export default class GatewayAuthDisable extends Command {
  static readonly description =
    'Remove the SSO gate from a gateway route (the route becomes public again).';

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
    const { args, flags } = await this.parse(GatewayAuthDisable);
    const spinner = ora('Disabling SSO on route...').start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const route = await resolveGatewayRoute(service, app.id, args.route);
      const updated = await service.setGatewayPolicy(app.id, route.endpointId, {
        auth: null,
      });
      spinner.succeed(
        `SSO disabled on ${updated.host} — reconciling in background`,
      );
      printRouteDetail(updated);
    } catch (error: any) {
      spinner.fail('Failed to disable SSO');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
