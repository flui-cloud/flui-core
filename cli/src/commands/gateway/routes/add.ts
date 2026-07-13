import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  GatewayMinRole,
} from '../../../lib/services/cli-app.service';
import { resolveCluster } from '../../../lib/resolve-cluster';
import { printRouteDetail, splitCidrList } from '../../../lib/gateway-utils';

export default class GatewayRoutesAdd extends Command {
  static readonly description =
    'Add a gateway route to an application: a host (and optional path prefix) ' +
    'pointing at the app service, with optional policies. DNS, TLS and Ingress ' +
    'reconcile in the background — check `flui gateway status`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app api.example.com',
    '<%= config.bin %> <%= command.id %> my-app api.example.com --path /v1 --sso --min-role viewer',
    '<%= config.bin %> <%= command.id %> my-app api.example.com --average 100 --burst 50 --allow-ip 203.0.113.0/24',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    host: Args.string({
      description: 'Hostname for the route, e.g. api.example.com',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    path: Flags.string({
      char: 'p',
      description: 'PathPrefix the route matches (default "/")',
    }),
    sso: Flags.boolean({
      description: 'Gate the route behind Flui SSO',
      default: false,
    }),
    'min-role': Flags.string({
      description: 'Minimum IAM role required to pass the SSO gate',
      options: ['viewer', 'editor', 'manager'],
      dependsOn: ['sso'],
    }),
    average: Flags.integer({
      description: 'Rate limit: sustained requests per period',
    }),
    burst: Flags.integer({
      description: 'Rate limit: burst capacity',
      dependsOn: ['average'],
    }),
    period: Flags.string({
      description: 'Rate limit period (e.g. 1s, 1m). Default 1s',
      dependsOn: ['average'],
    }),
    'allow-ip': Flags.string({
      description: 'CIDR allowlist entry (repeatable or comma-separated)',
      multiple: true,
    }),
    'no-tls': Flags.boolean({
      description: 'Skip TLS certificate issuance for this route',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GatewayRoutesAdd);
    const spinner = ora(`Adding route ${args.host}...`).start();
    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);

      const allowIps = (flags['allow-ip'] ?? []).flatMap(splitCidrList);
      const route = await service.addGatewayRoute(app.id, {
        host: args.host,
        path: flags.path,
        certificateRequired: !flags['no-tls'],
        auth: flags.sso
          ? { sso: true, minRole: flags['min-role'] as GatewayMinRole }
          : undefined,
        rateLimit: flags.average
          ? { average: flags.average, burst: flags.burst, period: flags.period }
          : undefined,
        allowIps: allowIps.length ? allowIps : undefined,
      });

      spinner.succeed(`Route ${route.host} added — reconciling in background`);
      printRouteDetail(route);
      console.log(
        chalk.dim(`  Watch it land with: flui gateway status ${args.app}\n`),
      );
    } catch (error: any) {
      spinner.fail('Failed to add route');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
