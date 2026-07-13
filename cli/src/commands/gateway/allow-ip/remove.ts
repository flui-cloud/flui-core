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

export default class GatewayAllowIpRemove extends Command {
  static readonly description =
    'Remove CIDR ranges from the IP allowlist of a gateway route. When the ' +
    'last entry is removed the IP filter is dropped entirely (route open to all).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app api.example.com 203.0.113.0/24',
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
      description: 'CIDR range(s) to remove, comma-separated',
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
    const { args, flags } = await this.parse(GatewayAllowIpRemove);
    const spinner = ora('Updating IP allowlist...').start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      const route = await resolveGatewayRoute(service, app.id, args.route);
      const toRemove = new Set(splitCidrList(args.cidr));
      const remaining = (route.allowIps ?? []).filter(
        (ip) => !toRemove.has(ip),
      );
      const updated = await service.setGatewayPolicy(app.id, route.endpointId, {
        allowIps: remaining.length ? remaining : null,
      });
      spinner.succeed(
        remaining.length
          ? `IP allowlist updated on ${updated.host} — reconciling in background`
          : `IP filter removed from ${updated.host} — reconciling in background`,
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
