import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveCluster } from '../../../lib/resolve-cluster';
import {
  printRouteDetail,
  resolveGatewayRoute,
} from '../../../lib/gateway-utils';

export default class GatewayLimitSet extends Command {
  static readonly description =
    'Set a rate limit on a gateway route (sustained average per period, ' +
    'with optional burst).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app api.example.com --average 100 --burst 50',
    '<%= config.bin %> <%= command.id %> my-app api.example.com --average 10 --period 1m',
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
    average: Flags.integer({
      description: 'Sustained requests per period',
      required: true,
    }),
    burst: Flags.integer({
      description: 'Burst capacity above the average',
    }),
    period: Flags.string({
      description: 'Averaging window (e.g. 1s, 1m, 1h). Default 1s',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GatewayLimitSet);
    const spinner = ora('Setting rate limit...').start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const route = await resolveGatewayRoute(service, app.id, args.route);
      const updated = await service.setGatewayPolicy(app.id, route.endpointId, {
        rateLimit: {
          average: flags.average,
          burst: flags.burst,
          period: flags.period,
        },
      });
      spinner.succeed(
        `Rate limit set on ${updated.host} — reconciling in background`,
      );
      printRouteDetail(updated);
    } catch (error: any) {
      spinner.fail('Failed to set rate limit');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
