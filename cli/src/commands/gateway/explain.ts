import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveCluster } from '../../lib/resolve-cluster';
import { reconciliationLabel, tlsLabel } from '../../lib/gateway-utils';

export default class GatewayExplain extends Command {
  static readonly description =
    'Explain how the gateway handles a URL: which route matches and the ' +
    'middleware chain (IP filter → rate limit → SSO) a request goes through.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> https://api.example.com/v1/posts',
  ];

  static readonly args = {
    url: Args.string({
      description: 'URL (or host) to explain',
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
    const { args, flags } = await this.parse(GatewayExplain);
    const spinner = ora('Resolving route...').start();
    try {
      const { host, path } = this.parseTarget(args.url);
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const routes = await service.listClusterGatewayRoutes(clusterId);

      spinner.stop();

      const candidates = routes.filter(
        (r) => r.host.toLowerCase() === host.toLowerCase(),
      );
      if (candidates.length === 0) {
        console.log(
          chalk.yellow(
            `\n  No gateway route matches host ${chalk.bold(host)} on this cluster.\n`,
          ),
        );
        this.exit(1);
        return;
      }

      // Longest matching PathPrefix wins (Traefik rule priority by length).
      const match = candidates
        .filter((r) => path === r.path || path.startsWith(this.prefix(r.path)))
        .sort((a, b) => b.path.length - a.path.length)[0];

      if (!match) {
        console.log(
          chalk.yellow(
            `\n  Host ${chalk.bold(host)} is routed, but no route matches path ${chalk.bold(path)}.`,
          ),
        );
        console.log(
          `  Routes on this host: ${candidates.map((r) => r.path).join(', ')}\n`,
        );
        this.exit(1);
        return;
      }

      console.log('');
      const appLabel = chalk.bold(
        match.applicationSlug ?? match.applicationName ?? match.service,
      );
      const serviceLabel = chalk.dim(`(${match.service})`);
      console.log(
        `  ${chalk.bold(host)}${chalk.dim(path)} → ${appLabel} ${serviceLabel}`,
      );
      console.log(
        `  Route: ${match.host}${match.path}  TLS: ${tlsLabel(match)}  Status: ${reconciliationLabel(match.reconciliationStatus)}`,
      );
      console.log('');
      console.log(`  ${chalk.bold('Request chain:')}`);
      let step = 1;
      if (match.allowIps?.length) {
        console.log(
          `    ${step++}. IP filter — allowed only from: ${match.allowIps.join(', ')}`,
        );
        console.log(
          chalk.dim(
            '       Requests from any other source are rejected (403).',
          ),
        );
      }
      if (match.rateLimit?.average) {
        const burst = match.rateLimit.burst
          ? `, burst ${match.rateLimit.burst}`
          : '';
        console.log(
          `    ${step++}. Rate limit — ${match.rateLimit.average} req/${match.rateLimit.period ?? '1s'}${burst}`,
        );
        console.log(
          chalk.dim('       Requests over the limit are rejected (429).'),
        );
      }
      if (match.auth?.sso) {
        const minRole = match.auth.minRole
          ? `, minimum role: ${match.auth.minRole}`
          : '';
        console.log(
          `    ${step++}. SSO gate — Flui session required${minRole}`,
        );
        console.log(
          chalk.dim(
            '       Requests without a valid session are rejected (401).',
          ),
        );
      }
      console.log(`    ${step}. Forwarded to ${match.service}`);
      if (step === 1) {
        console.log(
          chalk.dim('       No gateway policies — direct default route.'),
        );
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to explain URL');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }

  private parseTarget(input: string): { host: string; path: string } {
    const withScheme = input.includes('://') ? input : `https://${input}`;
    try {
      const url = new URL(withScheme);
      return { host: url.hostname, path: url.pathname || '/' };
    } catch {
      return { host: input.split('/')[0], path: '/' };
    }
  }

  private prefix(routePath: string): string {
    return routePath === '/' ? '/' : `${routePath}/`.replace(/\/\/$/, '/');
  }
}
