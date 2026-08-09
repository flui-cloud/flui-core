import { Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../../lib/nest-app';
import { printContextBanner } from '../../../lib/context-banner';
import { CliControlClusterService } from '../../../services/cli-control-cluster.service';
import { CliClusterCreatorService } from '../../../services/cli-cluster-creator.service';
import { ConfigStorage } from '../../../lib/config-storage';
import { ApiClient, ApiError } from '../../../lib/api-client';

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
  lastAppliedRules?: FirewallRule[];
  reconciliationStatus: string;
  hasDrift: boolean;
  coverageStatus?: string;
  lastReconciliationAt?: string;
  errorMessage?: string;
}

export default class EnvFirewallStatus extends Command {
  static readonly description =
    'Show the control cluster host firewall: reconciliation state, drift against the desired rules, and the rules currently applied on the host.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  private printUnprotected(): void {
    console.log(
      chalk.red('\n   ✖ No firewall is configured for this cluster.\n'),
    );
    console.log(
      chalk.yellow(
        '   Nothing is filtering inbound traffic: kube-apiserver (6443), kubelet\n' +
          '   (10250) and NodePorts (30000-32767) may be reachable from the internet.\n',
      ),
    );
    console.log(
      chalk.dim('   Apply it with: ' + chalk.cyan('flui env firewall apply')),
    );
    console.log();
  }

  private printSummary(firewall: FirewallResponse): void {
    const drift = firewall.hasDrift ? chalk.yellow('yes') : chalk.green('no');
    console.log(
      `\n   ${chalk.bold('Reconciliation:')} ${firewall.reconciliationStatus}`,
    );
    console.log(`   ${chalk.bold('Drift:')}          ${drift}`);
    if (firewall.coverageStatus) {
      console.log(
        `   ${chalk.bold('Coverage:')}       ${firewall.coverageStatus}`,
      );
    }
    if (firewall.lastReconciliationAt) {
      console.log(
        `   ${chalk.bold('Last applied:')}   ${firewall.lastReconciliationAt}`,
      );
    }
    if (firewall.errorMessage) {
      console.log(
        `   ${chalk.bold('Error:')}          ${chalk.red(firewall.errorMessage)}`,
      );
    }
  }

  /** Prefers what the host actually has over what the DB wants. */
  private printRules(firewall: FirewallResponse): void {
    const applied = firewall.lastAppliedRules?.length
      ? firewall.lastAppliedRules
      : firewall.desiredRules;
    const inbound = (applied ?? []).filter((r) => r.direction !== 'out');
    if (!inbound.length) return;

    console.log(chalk.dim('\n   Inbound:\n'));
    for (const r of inbound) {
      const proto = chalk.bold((r.protocol ?? 'tcp').toUpperCase());
      const port = chalk.cyan(r.port ?? '-');
      const from = chalk.dim(
        'from ' + ((r.sourceIps ?? []).join(', ') || 'any'),
      );
      console.log(`   ${proto} ${port}  ${from}`);
    }
  }

  private async fetchFirewall(
    api: ApiClient,
    clusterId: string,
  ): Promise<FirewallResponse | null> {
    try {
      return await api.get<FirewallResponse>(`/firewalls/cluster/${clusterId}`);
    } catch (error) {
      const status = error instanceof ApiError ? error.statusCode : undefined;
      if (status === 404 || status === 400) return null;
      throw error;
    }
  }

  async run(): Promise<void> {
    printContextBanner();
    const spinner = ora('Loading firewall...').start();

    try {
      const app = await getNestApp();
      const cluster = await app
        .get(CliControlClusterService)
        .getControlCluster();
      if (!cluster) {
        spinner.fail('No control cluster found');
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

      const api = new ApiClient({ baseUrl: cfg.getApiUrlOrThrow(), apiKey });
      const firewall = await this.fetchFirewall(api, cluster.id);
      if (!firewall) {
        spinner.stop();
        this.printUnprotected();
        this.exit(1);
        return;
      }

      spinner.succeed(`Firewall for ${cluster.name}`);
      this.printSummary(firewall);
      this.printRules(firewall);

      if (firewall.hasDrift) {
        console.log(
          chalk.dim(
            '\n   Re-apply with: ' + chalk.cyan('flui env firewall apply'),
          ),
        );
      }
      console.log();
    } catch (error) {
      if ((error as { oclif?: unknown }).oclif) throw error;
      spinner.fail('Failed to read the host firewall');
      console.log(chalk.red(`\n❌ ${(error as Error).message}\n`));
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
