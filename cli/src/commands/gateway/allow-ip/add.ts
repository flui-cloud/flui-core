import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveCluster } from '../../../lib/resolve-cluster';
import {
  printRouteDetail,
  resolveGatewayRoute,
  splitCidrList,
} from '../../../lib/gateway-utils';

export default class GatewayAllowIpAdd extends Command {
  static readonly description =
    'Add CIDR ranges to the IP allowlist of a gateway route. Once the ' +
    'allowlist is non-empty, requests from any other source are rejected.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app api.example.com 203.0.113.0/24',
    '<%= config.bin %> <%= command.id %> my-app api.example.com 10.0.0.0/8,192.168.0.0/16',
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
    cidr: Args.string({
      description: 'CIDR range(s), comma-separated',
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
    const { args, flags } = await this.parse(GatewayAllowIpAdd);
    const spinner = ora('Updating IP allowlist...').start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const route = await resolveGatewayRoute(service, app.id, args.route);
      const merged = [
        ...new Set([...(route.allowIps ?? []), ...splitCidrList(args.cidr)]),
      ];
      const updated = await service.setGatewayPolicy(app.id, route.endpointId, {
        allowIps: merged,
      });
      spinner.succeed(
        `IP allowlist updated on ${updated.host} — reconciling in background`,
      );
      printRouteDetail(updated);
    } catch (error: any) {
      spinner.fail('Failed to update IP allowlist');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
