import { Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import {
  CliEndpointResolverService,
  SystemEndpoints,
} from '../../services/cli-endpoint-resolver.service';
import { ClusterStatus } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { printContextBanner } from '../../lib/context-banner';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterSshTarget } from '../../lib/cluster-ssh-target';
import { buildNipBaseDomain } from '../../lib/nip-base-domain.util';

export default class EnvStatus extends Command {
  static readonly description = 'Check control cluster status';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    printContextBanner();
    let spinner = ora('Checking cluster status...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const resolver = app.get(CliEndpointResolverService);

      const cluster = await controlService.getControlCluster();

      if (!cluster) {
        spinner.fail('No control cluster found');
        console.log(chalk.yellow('\n⚠️  No control cluster exists.\n'));
        console.log(chalk.dim('Create one with:'));
        console.log(`   ${chalk.cyan('flui env create')}\n`);
        return;
      }

      spinner.succeed('Cluster found');

      if (cluster.masterIpAddress) {
        const storage = new ConfigStorage();
        const derived = `https://api.${buildNipBaseDomain(cluster.masterIpAddress, cluster.nipHostnameToken)}/api/v1`;
        if (storage.getApiUrl() !== derived) {
          storage.saveApiUrl(derived);
        }
      }

      console.log(chalk.cyan('\n📋 Control Cluster Status\n'));
      console.log(`   ${chalk.bold('Name:')}       ${cluster.name}`);
      console.log(`   ${chalk.bold('ID:')}         ${cluster.id}`);
      console.log(
        `   ${chalk.bold('Status:')}     ${this.formatStatus(cluster.status)}`,
      );
      console.log(`   ${chalk.bold('Provider:')}   ${cluster.provider}`);
      console.log(`   ${chalk.bold('Region:')}     ${cluster.region}`);
      console.log(
        `   ${chalk.bold('Master IP:')}  ${cluster.masterIpAddress || 'N/A'}`,
      );
      console.log(`   ${chalk.bold('Nodes:')}      ${cluster.nodeCount}`);
      console.log(
        `   ${chalk.bold('Created:')}    ${cluster.createdAt.toLocaleString()}`,
      );

      // Get nodes info
      if (cluster.nodes && cluster.nodes.length > 0) {
        console.log(chalk.cyan('\n🖥️  Cluster Nodes:\n'));
        for (const node of cluster.nodes) {
          const marker =
            node.nodeType === 'master' ? chalk.cyan('●') : chalk.dim('●');
          console.log(`   ${marker} ${chalk.bold(node.serverName)}`);
          console.log(`      Type: ${node.nodeType}`);
          console.log(`      IP: ${node.ipAddress || 'N/A'}`);
          console.log(`      Status: ${this.formatStatus(node.status)}`);
        }
      }

      if (cluster.status === ClusterStatus.READY && cluster.masterIpAddress) {
        spinner = await this.renderObservabilityHealth(
          controlService,
          cluster.masterIpAddress,
          cluster.nipHostnameToken,
          spinner,
          resolveClusterSshTarget(cluster, cluster.masterIpAddress),
        );
      } else if (cluster.status === ClusterStatus.STOPPED) {
        console.log(chalk.cyan('\n💤 Cluster Status:\n'));
        console.log(
          `   ${chalk.yellow('Cluster is currently stopped to save costs')}`,
        );
        console.log(`   ${chalk.dim('To restart it, run:')}`);
        console.log(`   ${chalk.cyan('flui env restart')}\n`);
      }

      if (cluster.status === ClusterStatus.READY && cluster.masterIpAddress) {
        spinner = await this.renderEndpointsAndCredentials(
          resolver,
          cluster,
          spinner,
        );
        console.log(chalk.bold('\n   To retrieve your credentials, run:'));
        console.log(chalk.cyan('   flui env credentials\n'));
      }

      console.log('');
    } catch (error) {
      spinner.fail('Failed to check cluster status');
      console.log(chalk.red('\n❌ Error:\n'));

      if (error instanceof Error) {
        console.log(`   ${error.message}\n`);
      } else {
        console.log(`   ${String(error)}\n`);
      }

      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private async renderObservabilityHealth(
    controlService: CliControlClusterService,
    masterIp: string,
    nipHostnameToken: string | null | undefined,
    initialSpinner: ReturnType<typeof ora>,
    sshTarget?: { host: string; port: number; user: string },
  ): Promise<ReturnType<typeof ora>> {
    initialSpinner.stop();
    const spinner = ora('Checking observability services...').start();
    try {
      const servicesHealth = await controlService.checkObservabilityServices(
        masterIp,
        nipHostnameToken,
        sshTarget,
      );
      spinner.succeed('Services health checked');

      console.log(chalk.cyan('\n📊 Observability Services Status:\n'));
      const note = chalk.dim('(deployment ready)');
      const rows: Array<[string, string]> = [
        ['Metrics:   ', servicesHealth.prometheus],
        ['Grafana:   ', servicesHealth.grafana],
        ['Loki:      ', servicesHealth.loki],
        ['Postgres:  ', servicesHealth.postgres],
        ['Redis:     ', servicesHealth.redis],
        ['Flui API:  ', servicesHealth.fluiApi],
        ['Dashboard: ', servicesHealth.fluiWeb],
      ];
      for (const [label, status] of rows) {
        const icon = status === 'healthy' ? '✅' : '❌';
        const color = status === 'healthy' ? chalk.green : chalk.red;
        console.log(`   ${icon} ${chalk.bold(label)} ${color(status)} ${note}`);
      }
    } catch (error) {
      spinner.warn('Could not check services health');
      console.log(chalk.dim(`   ${(error as Error).message}\n`));
    }
    return spinner;
  }

  private async renderEndpointsAndCredentials(
    resolver: CliEndpointResolverService,
    cluster: any,
    initialSpinner: ReturnType<typeof ora>,
  ): Promise<ReturnType<typeof ora>> {
    initialSpinner.stop();
    const spinner = ora('Resolving effective endpoints via SSH...').start();
    try {
      const endpoints = await resolver.resolveEndpoints(
        cluster.masterIpAddress,
        cluster.nipHostnameToken,
        resolveClusterSshTarget(cluster, cluster.masterIpAddress),
      );
      spinner.succeed('Endpoints resolved');
      this.renderEndpoints(endpoints);

      const passwords = cluster.metadata?.observabilityStack?.passwords;
      if (passwords) {
        console.log(chalk.cyan('\n🔑 Credentials:\n'));
        console.log(
          `   ${chalk.bold('Grafana:')}    admin / ${chalk.yellow(passwords.grafana)}`,
        );
        console.log(
          `   ${chalk.bold('PostgreSQL:')} fluicloud / ${chalk.yellow(passwords.postgres)}`,
        );
        console.log(
          `   ${chalk.bold('Redis:')}      ${chalk.yellow(passwords.redis)}`,
        );
      }
    } catch {
      spinner.warn('Could not fetch all endpoints');
    }
    return spinner;
  }

  private formatStatus(status: string): string {
    const statusColors: Record<string, any> = {
      creating: chalk.yellow,
      ready: chalk.green,
      scaling: chalk.blue,
      stopped: chalk.yellow,
      error: chalk.red,
      deleting: chalk.red,
      deleted: chalk.dim,
    };

    const color = statusColors[status.toLowerCase()] || chalk.white;
    return color(status.toUpperCase());
  }

  private renderEndpoints(endpoints: SystemEndpoints): void {
    console.log(chalk.cyan('\n🔗 Service Endpoints:\n'));
    console.log(
      `   ${chalk.bold('Auth mode:')} ${chalk.blue(endpoints.authMode)}`,
    );

    const rows: Array<[string, SystemEndpoints[keyof SystemEndpoints]]> = [
      ['Flui API  ', endpoints.fluiApi],
      ['Dashboard ', endpoints.fluiWeb],
      ['Zitadel   ', endpoints.zitadel],
      ['Grafana   ', endpoints.grafana],
      ['Prometheus', endpoints.prometheus],
      ['Loki      ', endpoints.loki],
    ];

    for (const [label, info] of rows) {
      if (
        typeof info !== 'object' ||
        info === null ||
        !('effectiveUrl' in info)
      )
        continue;
      const marker = info.synced ? chalk.green('●') : chalk.dim('○');
      const url = info.synced
        ? chalk.blue(info.effectiveUrl)
        : chalk.dim(info.effectiveUrl);
      const suffix = info.synced
        ? chalk.dim(' (custom domain)')
        : chalk.dim(' (in-cluster only)');
      console.log(`   ${marker} ${chalk.bold(label)} ${url}${suffix}`);
    }
  }
}
