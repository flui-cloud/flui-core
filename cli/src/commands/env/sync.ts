import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import {
  CliEndpointResolverService,
  SystemEndpoints,
} from '../../services/cli-endpoint-resolver.service';
import { CliSshService } from '../../services/cli-ssh.service';
import { resolveClusterSshTarget } from '../../lib/cluster-ssh-target';
import { ConfigStorage } from '../../lib/config-storage';
import { ClusterStatus } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { updateEnvContent } from '../../lib/utils/env-file';
import { printContextBanner } from '../../lib/context-banner';

export default class EnvSync extends Command {
  static readonly description =
    'Sync endpoint URLs (API, OIDC, observability) from the cluster via SSH+kubectl.\n' +
    'Safe for production: reads only K8s Ingress/ConfigMap/Secret, never touches DB/Redis credentials.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dry-run',
  ];

  static readonly flags = {
    'dry-run': Flags.boolean({
      description:
        'Show what would change without modifying .env or config.json',
      default: false,
    }),
    debug: Flags.boolean({
      description: 'Print raw ingress list from the cluster for diagnostics',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvSync);
    printContextBanner();
    const spinner = ora('Connecting to cluster master via SSH...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const resolver = app.get(CliEndpointResolverService);
      const sshService = app.get(CliSshService);

      const cluster = await controlService.getControlCluster();

      if (!cluster) {
        spinner.fail('No control cluster found');
        console.log(chalk.yellow('\n⚠️  No control cluster exists.\n'));
        console.log(chalk.dim('Create one with:'));
        console.log(`   ${chalk.cyan('flui env create')}\n`);
        return;
      }

      if (cluster.status !== ClusterStatus.READY) {
        spinner.fail(`Cluster is not ready (status: ${cluster.status})`);
        return;
      }

      const masterIp = cluster.masterIpAddress;
      if (!masterIp) {
        spinner.fail('Master IP address not available');
        return;
      }

      const sshT = resolveClusterSshTarget(cluster, masterIp);
      const endpoints = await resolver.resolveEndpoints(
        masterIp,
        cluster.nipHostnameToken,
        sshT,
      );
      spinner.succeed('Endpoints resolved from cluster');

      if (flags.debug) {
        console.log(chalk.cyan('\n🔬 Debug: ingresses on cluster\n'));
        try {
          const raw = await sshService.sshExec(
            sshT.host,
            "kubectl get ingress -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,HOSTS:.spec.rules[*].host,LABELS:.metadata.labels' 2>/dev/null || echo '(kubectl failed)'",
            sshT.user,
            sshT.port,
          );
          console.log(raw || chalk.dim('(no ingresses found)'));
        } catch (err) {
          console.log(
            chalk.red(
              `Debug failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
        console.log();
      }

      const envVars = this.buildEnvVars(endpoints);

      this.displayEndpoints(cluster.name, masterIp, endpoints);

      const configStorage = new ConfigStorage();
      const previousApiUrl = configStorage.getApiUrl();
      const nextApiUrl = this.deriveApiUrl(endpoints);

      this.displayDiff(previousApiUrl, nextApiUrl, envVars);

      if (flags['dry-run']) {
        console.log(chalk.yellow('\n🔍 Dry run mode — no changes applied.\n'));
        return;
      }

      this.writeEnvFile(envVars);
      configStorage.saveApiUrl(nextApiUrl);

      console.log(chalk.green('\n✅ Endpoints synced successfully.\n'));
    } catch (error) {
      spinner.fail('Failed to sync endpoints');
      console.error(
        chalk.red(
          `\n❌ ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
      console.log(
        chalk.dim(
          'Troubleshooting: verify SSH access to the master node and that `kubectl` is available there.\n',
        ),
      );
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private buildEnvVars(endpoints: SystemEndpoints): Record<string, string> {
    const envVars: Record<string, string> = {
      AUTH_MODE: endpoints.authMode,
      GRAFANA_URL: endpoints.grafana.effectiveUrl,
      PROMETHEUS_ENDPOINT: endpoints.prometheus.effectiveUrl,
      LOKI_ENDPOINT: endpoints.loki.effectiveUrl,
    };

    const issuer = this.resolveOidcIssuer(endpoints);
    if (issuer) envVars.OIDC_ISSUER = issuer;

    const jwks = this.resolveOidcJwksUri(endpoints, issuer);
    if (jwks) envVars.OIDC_JWKS_URI = jwks;

    if (endpoints.oidcAudience) {
      envVars.OIDC_AUDIENCE = endpoints.oidcAudience;
    }

    return envVars;
  }

  private resolveOidcIssuer(endpoints: SystemEndpoints): string {
    // Prefer the Ingress (source of truth for the live domain) over the ConfigMap,
    // which can lag behind when the auth-domain-sync hasn't caught up.
    if (endpoints.zitadel.fqdn) return `https://${endpoints.zitadel.fqdn}`;
    if (endpoints.oidcIssuer) return endpoints.oidcIssuer;
    return '';
  }

  private resolveOidcJwksUri(
    endpoints: SystemEndpoints,
    issuer: string,
  ): string {
    const raw = endpoints.oidcJwksUri;
    const isInCluster = raw.includes('.svc.cluster.local');
    if (raw && !isInCluster) return raw;
    if (issuer) return `${issuer.replace(/\/$/, '')}/oauth/v2/keys`;
    return '';
  }

  private deriveApiUrl(endpoints: SystemEndpoints): string {
    const base = endpoints.fluiApi.effectiveUrl.replace(/\/$/, '');
    return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
  }

  private displayEndpoints(
    clusterName: string,
    masterIp: string,
    endpoints: SystemEndpoints,
  ): void {
    console.log(chalk.cyan('\n📋 Resolved Endpoints\n'));
    console.log(`   ${chalk.bold('Cluster:')}    ${clusterName}`);
    console.log(`   ${chalk.bold('Master IP:')}  ${masterIp}`);
    console.log(`   ${chalk.bold('Auth mode:')}  ${endpoints.authMode}\n`);

    const rows: Array<
      [string, { fqdn: string | null; effectiveUrl: string; synced: boolean }]
    > = [
      ['Flui API', endpoints.fluiApi],
      ['Flui Web', endpoints.fluiWeb],
      ['Zitadel', endpoints.zitadel],
      ['Grafana', endpoints.grafana],
      ['Prometheus', endpoints.prometheus],
      ['Loki', endpoints.loki],
    ];

    for (const [label, info] of rows) {
      const marker = info.synced ? chalk.green('●') : chalk.dim('○');
      const url = info.synced
        ? chalk.blue(info.effectiveUrl)
        : chalk.dim(info.effectiveUrl);
      console.log(`   ${marker} ${chalk.bold(label.padEnd(12))} ${url}`);
    }
  }

  private displayDiff(
    previousApiUrl: string,
    nextApiUrl: string,
    envVars: Record<string, string>,
  ): void {
    console.log(chalk.cyan('\n🔄 Changes to apply:\n'));

    if (previousApiUrl === nextApiUrl) {
      console.log(`   ${chalk.dim('apiUrl unchanged:')} ${previousApiUrl}`);
    } else {
      console.log(`   ${chalk.bold('apiUrl (config.json):')}`);
      console.log(`     ${chalk.red('- ' + previousApiUrl)}`);
      console.log(`     ${chalk.green('+ ' + nextApiUrl)}`);
    }

    console.log(`\n   ${chalk.bold('.env keys:')}`);
    for (const [k, v] of Object.entries(envVars)) {
      const shown = /SECRET|KEY|PASSWORD|AUDIENCE/i.test(k)
        ? chalk.yellow('******')
        : v;
      console.log(`     ${k}=${shown}`);
    }
  }

  private writeEnvFile(envVars: Record<string, string>): void {
    const envPath = path.join(process.cwd(), '.env');
    const envExamplePath = path.join(process.cwd(), '.env.example');

    let existing = '';
    if (fs.existsSync(envPath)) {
      existing = fs.readFileSync(envPath, 'utf-8');
    } else if (fs.existsSync(envExamplePath)) {
      existing = fs.readFileSync(envExamplePath, 'utf-8');
    }

    const updated = updateEnvContent(existing, envVars);
    fs.writeFileSync(envPath, updated, 'utf-8');
  }
}
