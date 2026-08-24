import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  GatewayMinRole,
} from '../../../lib/services/cli-app.service';
import { resolveCluster } from '../../../lib/resolve-cluster';
import {
  printRouteDetail,
  resolveGatewayRoute,
} from '../../../lib/gateway-utils';

export default class GatewayAuthEnable extends Command {
  static readonly description =
    'Put a gateway route behind Flui SSO. Every request must carry a valid ' +
    'Flui session; --min-role additionally requires that IAM role on the app.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app api.example.com',
    '<%= config.bin %> <%= command.id %> my-app api.example.com --min-role operator',
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
    'min-role': Flags.string({
      description: 'Minimum IAM role required (viewer < operator < maintainer)',
      options: ['viewer', 'operator', 'maintainer'],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GatewayAuthEnable);
    const spinner = ora('Enabling SSO on route...').start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const route = await resolveGatewayRoute(service, app.id, args.route);
      const updated = await service.setGatewayPolicy(app.id, route.endpointId, {
        auth: { sso: true, minRole: flags['min-role'] as GatewayMinRole },
      });
      spinner.succeed(
        `SSO enabled on ${updated.host} — reconciling in background`,
      );
      printRouteDetail(updated);
    } catch (error: any) {
      spinner.fail('Failed to enable SSO');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
