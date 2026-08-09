import { Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../../lib/nest-app';
import { printContextBanner } from '../../../lib/context-banner';
import { CliControlClusterService } from '../../../services/cli-control-cluster.service';
import { CliClusterCreatorService } from '../../../services/cli-cluster-creator.service';
import { ConfigStorage } from '../../../lib/config-storage';
import { ApiClient, ApiError } from '../../../lib/api-client';
import { ClusterStatus } from 'src/modules/infrastructure/clusters/entities/cluster.entity';

interface FirewallRule {
  description?: string;
  direction?: string;
  protocol?: string;
  port?: string;
  sourceIps?: string[];
}

interface FirewallResponse {
  id: string;
  desiredRules: FirewallRule[];
  reconciliationStatus: string;
  hasDrift: boolean;
  errorMessage?: string;
}

export default class EnvFirewallApply extends Command {
  static readonly description =
    'Apply the control cluster firewall. Seeds the default ruleset when none exists, then reconciles it — default deny, with only the declared inbound rules open. Idempotent: safe to re-run. Which mechanism enforces it is resolved from the provider (a managed cloud firewall, or an nftables ruleset on the host itself) and does not change the command or its rules.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  private printRules(rules: FirewallRule[]): void {
    const inbound = rules.filter((r) => r.direction !== 'out');
    if (!inbound.length) return;
    console.log(chalk.dim('\n   Inbound rules applied:\n'));
    for (const r of inbound) {
      const proto = chalk.bold((r.protocol ?? 'tcp').toUpperCase());
      const port = chalk.cyan(r.port ?? '-');
      const from = chalk.dim(
        'from ' + ((r.sourceIps ?? []).join(', ') || 'any'),
      );
      const note = r.description ? chalk.dim(' — ' + r.description) : '';
      console.log(`   ${proto} ${port}  ${from}${note}`);
    }
    console.log();
  }

  async run(): Promise<void> {
    printContextBanner();
    const spinner = ora('Loading cluster...').start();
    let app: any;

    try {
      app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const cluster = await controlService.getControlCluster();
      if (!cluster) {
        spinner.fail('No control cluster found');
        console.log(chalk.dim('\nCreate one with:'));
        console.log(`   ${chalk.cyan('flui env create')}\n`);
        this.exit(1);
        return;
      }

      const cfg = new ConfigStorage();
      const apiKey =
        cfg.getApiKey() ||
        app.get(CliClusterCreatorService).getClusterApiKey(cluster);
      if (!apiKey) {
        spinner.fail('No credentials to reach the control plane');
        console.log(
          chalk.dim(`\nRun ${chalk.cyan('flui auth login')} first.\n`),
        );
        this.exit(1);
        return;
      }
      const api = new ApiClient({
        baseUrl: cfg.getApiUrlOrThrow(),
        apiKey,
      });

      spinner.text = `Applying host firewall to ${cluster.name}...`;
      const firewall = await api.post<FirewallResponse>(
        `/firewalls/cluster/${cluster.id}/enable`,
        {},
      );
      spinner.succeed(`Host firewall applied to ${cluster.name}`);

      this.printRules(firewall.desiredRules ?? []);

      if (firewall.hasDrift) {
        console.log(
          chalk.yellow(
            '   ⚠ The host still reports drift from the desired rules.\n',
          ),
        );
      }
      console.log(
        chalk.dim(
          `   Verify with: ${chalk.cyan('flui env firewall status')}\n`,
        ),
      );

      if (cluster.status !== ClusterStatus.READY) {
        console.log(
          chalk.yellow(
            `   The cluster is still ${cluster.status}. Once you have checked it over,\n` +
              `   clear the state with ${chalk.cyan('flui env force-ready')}.\n`,
          ),
        );
      }
    } catch (error) {
      if ((error as { oclif?: unknown }).oclif) throw error;
      spinner.fail('Failed to apply the host firewall');
      const status = error instanceof ApiError ? error.statusCode : undefined;
      console.log(chalk.red(`\n❌ ${(error as Error).message}\n`));
      if (status === 401 || status === 403) {
        console.log(
          chalk.dim(
            `   Re-authenticate with ${chalk.cyan('flui auth login')}.\n`,
          ),
        );
      } else if (status === 400 || status === 404) {
        console.log(
          chalk.dim(
            '   The control plane does not know this cluster. Check `flui env status`.\n',
          ),
        );
      } else {
        console.log(
          chalk.dim(
            '   Applying reaches either the provider API or the host over SSH, depending\n' +
              '   on the cluster. Check that the master is up and that the provider\n' +
              '   credentials — or Flui’s SSH access to it — are still valid.\n',
          ),
        );
      }
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
