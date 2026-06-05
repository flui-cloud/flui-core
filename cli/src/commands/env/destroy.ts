import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { printContextBanner } from '../../lib/context-banner';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { ConfigStorage } from '../../lib/config-storage';
import { confirmByTypingPrompt } from '../../lib/prompts';
import { VnetProvisioningService } from '../../lib/services/vnet-provisioning.service';

export default class EnvDestroy extends Command {
  static readonly description =
    'Permanently delete control cluster (WARNING: All data will be lost!)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --force',
  ];

  static readonly flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    }),
  };

  // Drop config tied to the deleted cluster: registration, API endpoint and key.
  private cleanupClusterScopedConfig(): void {
    const spinner = ora('Cleaning up configuration...').start();
    try {
      const configStorage = new ConfigStorage();
      const config = configStorage['readConfig']();
      let changed = false;
      if (config.credentials?.['observability-cluster-registration']) {
        delete config.credentials['observability-cluster-registration'];
        changed = true;
      }
      if (config.apiUrl) {
        delete config.apiUrl;
        if (config.metadata) delete config.metadata.apiUrlUpdatedAt;
        changed = true;
      }
      if (config.apiKey) {
        delete config.apiKey;
        changed = true;
      }
      if (changed) {
        configStorage['writeConfig'](config);
        spinner.succeed('Configuration cleaned up');
      } else {
        spinner.info('No configuration to clean up');
      }
    } catch (error) {
      spinner.warn(
        `Failed to clean up configuration: ${(error as Error).message}`,
      );
      console.log(chalk.yellow('   This is not critical, continuing...'));
    }
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvDestroy);

    printContextBanner();
    let spinner = ora('Initializing...').start();

    try {
      // Bootstrap NestJS and get services
      const app = await getNestApp();
      spinner.stop();

      console.log(chalk.red('\n⚠️  DESTROY Control Cluster\n'));
      spinner = ora('Checking for cluster...').start();
      const controlService = app.get(CliControlClusterService);

      // Find control cluster
      const cluster = await controlService.getControlCluster();

      if (!cluster) {
        spinner.fail('No control cluster found');
        console.log(chalk.yellow('\n⚠️  No control cluster exists.\n'));
        console.log(chalk.dim('Create one with:'));
        console.log(`   ${chalk.cyan('flui env create')}\n`);
        return;
      }

      spinner.succeed('Cluster found');

      // Display cluster info
      console.log(chalk.yellow('   Cluster to be deleted:\n'));
      console.log(`   ${chalk.bold('Name:')}       ${cluster.name}`);
      console.log(`   ${chalk.bold('ID:')}         ${cluster.id}`);
      console.log(`   ${chalk.bold('Status:')}     ${cluster.status}`);
      console.log(`   ${chalk.bold('Region:')}     ${cluster.region}`);
      console.log(`   ${chalk.bold('Nodes:')}      ${cluster.nodeCount}`);
      if (cluster.sharedStorageVolumeId) {
        console.log(
          `   ${chalk.bold('Shared storage:')} ${chalk.red(
            `${cluster.sharedStorageVolumeSizeGb ?? '?'} GB`,
          )} (volume ${cluster.sharedStorageVolumeId} will be deleted)`,
        );
      }
      console.log(chalk.red('\n   ⚠️  ALL DATA WILL BE PERMANENTLY LOST!'));
      console.log(
        chalk.dim(
          '   Cluster compute, attached block volumes and shared NFS storage are deleted at the provider.',
        ),
      );
      console.log(
        chalk.dim(
          '   Data survives destroy ONLY if covered by an active backup policy (S3-backed Velero / app backups).\n',
        ),
      );

      // Confirmation prompt: user must type the cluster name verbatim
      if (!flags.force) {
        console.log('');
        console.log(
          chalk.yellow(
            `   To confirm, type the cluster name exactly: ${chalk.bold(cluster.name)}`,
          ),
        );
        const confirmed = await confirmByTypingPrompt(
          chalk.yellow('⚠️  Cluster name'),
          cluster.name,
        );

        if (!confirmed) {
          console.log(
            chalk.green('\n✅ Deletion cancelled (name did not match)\n'),
          );
          return;
        }
      }

      // Delete cluster (servers will be fully deleted before firewall cleanup)
      console.log('');
      spinner = ora({
        text: 'Deleting cluster resources...',
        color: 'yellow',
      }).start();

      try {
        await controlService.deleteControlCluster();
        spinner.succeed('All cluster resources deleted successfully');
      } catch (error) {
        spinner.fail('Cluster deletion encountered an error');
        throw error;
      }

      this.cleanupClusterScopedConfig();

      // Tear down environment VNet/Subnet (must run AFTER all servers are deleted —
      // Hetzner refuses to delete a network that still has attached servers).
      try {
        spinner = ora('Removing environment VNet...').start();
        const vnetService = app.get(VnetProvisioningService);
        await vnetService.destroyEnvVnet();
        spinner.succeed('Environment VNet removed');
      } catch (error) {
        spinner.warn(`VNet teardown failed: ${(error as Error).message}`);
        console.log(
          chalk.yellow(
            '   You may need to delete the VNet manually from the Hetzner console.',
          ),
        );
      }

      console.log(chalk.green('\n✅ Control Cluster Deleted Successfully\n'));
      console.log(chalk.dim('   All cluster resources have been removed:'));
      console.log(chalk.dim('   • Servers (master and worker nodes)'));
      console.log(chalk.dim('   • Firewalls and security rules'));
      console.log(chalk.dim('   • Environment VNet/Subnet'));
      console.log(chalk.dim('   • SSH keys and bootstrap credentials'));
      console.log(chalk.dim('   • Local configuration\n'));
    } catch (error) {
      spinner.fail('Failed to destroy cluster');
      console.log(chalk.red('\n❌ Error:\n'));

      if (error instanceof Error) {
        console.log(`   ${error.message}`);

        if (error.message.includes('not found')) {
          console.log(chalk.yellow('\n💡 Hint:'));
          console.log(`   The cluster may have already been deleted.`);
          console.log(`   Check with: ${chalk.cyan('flui env status')}\n`);
        }
      } else {
        console.log(`   ${String(error)}`);
      }

      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
