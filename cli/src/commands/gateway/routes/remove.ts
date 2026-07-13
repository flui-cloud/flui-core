import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveCluster } from '../../../lib/resolve-cluster';
import { resolveGatewayRoute } from '../../../lib/gateway-utils';

export default class GatewayRoutesRemove extends Command {
  static readonly description =
    'Remove a gateway route from an application, cleaning up its DNS record, ' +
    'certificate, Ingress and middlewares.';

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
    const { args, flags } = await this.parse(GatewayRoutesRemove);
    const spinner = ora(`Removing route ${args.route}...`).start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const route = await resolveGatewayRoute(service, app.id, args.route);
      await service.removeGatewayRoute(app.id, route.endpointId);
      spinner.succeed(`Route ${route.host} removed`);
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to remove route');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
