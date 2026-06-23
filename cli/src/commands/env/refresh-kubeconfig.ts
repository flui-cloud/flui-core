import { Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliSshService } from '../../services/cli-ssh.service';
import { CliClusterRepository } from '../../lib/repositories/cli-cluster.repository';
import { EncryptionService } from 'src/modules/shared/encryption/services/encryption.service';
import { ClusterStatus } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { printContextBanner } from '../../lib/context-banner';
import { resolveClusterSshTarget } from '../../lib/cluster-ssh-target';

export default class EnvRefreshKubeconfig extends Command {
  static readonly description =
    'Refresh kubeconfig by fetching the real one from the K3s master via SSH.\n' +
    'This replaces the locally generated kubeconfig with the actual /etc/rancher/k3s/k3s.yaml.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    printContextBanner();
    const spinner = ora('Fetching kubeconfig from K3s master...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const sshService = app.get(CliSshService);
      const clusterRepo = app.get(CliClusterRepository);
      const encryptionService = app.get(EncryptionService);

      const cluster = await controlService.getControlCluster();

      if (!cluster) {
        spinner.fail('No control cluster found');
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

      // Fetch real kubeconfig from K3s master
      const t = resolveClusterSshTarget(cluster, masterIp);
      const raw = await sshService.sshExec(
        t.host,
        'sudo cat /etc/rancher/k3s/k3s.yaml',
        t.user,
        t.port,
      );

      // Replace localhost with real master IP
      const kubeconfig = raw.replaceAll('127.0.0.1', masterIp);

      // Encrypt and save
      cluster.kubeconfigEncrypted = encryptionService.encrypt(kubeconfig);
      await clusterRepo.save(cluster);

      spinner.succeed('Kubeconfig refreshed from K3s master');
      console.log(chalk.green(`\n  Cluster: ${cluster.name} (${cluster.id})`));
      console.log(chalk.green(`  Master:  ${masterIp}`));
      console.log(chalk.green(`  Size:    ${kubeconfig.length} bytes`));
      console.log(
        chalk.dim('\n  The kubeconfig now uses real K3s admin certificates.'),
      );
    } catch (error) {
      spinner.fail('Failed to refresh kubeconfig');
      console.error(chalk.red(`\n  ${error.message}\n`));
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
