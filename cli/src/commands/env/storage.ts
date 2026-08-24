import { Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import {
  openControlPlane,
  printControlPlaneError,
} from '../../lib/control-plane-api';
import {
  ClusterStorageStatus,
  ClusterStorageStatusDto,
} from 'src/modules/infrastructure/clusters/dto/cluster-storage.dto';
import { printContextBanner } from '../../lib/context-banner';

export default class EnvStorage extends Command {
  static readonly description =
    'Show shared storage status (Volume + NFS export + PVC summary) for the current control cluster';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    printContextBanner();
    const spinner = ora('Inspecting shared storage...').start();

    try {
      const { cluster, api } = await openControlPlane(await getNestApp());
      const status = await api.get<ClusterStorageStatusDto>(
        `/infrastructure/clusters/${cluster.id}/storage`,
      );
      spinner.succeed('Storage status retrieved');
      this.render(status);
    } catch (error) {
      spinner.fail('Failed to retrieve storage status');
      printControlPlaneError(error);
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private render(s: ClusterStorageStatusDto): void {
    console.log(chalk.cyan('\n💾 Cluster Shared Storage\n'));
    console.log(`   ${chalk.bold('Status:')}  ${this.formatStatus(s.status)}`);
    console.log(`   ${chalk.bold('Enabled:')} ${s.enabled ? 'yes' : 'no'}`);
    if (s.message) {
      console.log(`   ${chalk.dim(s.message)}`);
    }

    if (s.volume) {
      console.log(chalk.cyan('\n📦 Backing Volume\n'));
      console.log(`   ${chalk.bold('Provider:')}    ${s.volume.provider}`);
      console.log(`   ${chalk.bold('Volume ID:')}   ${s.volume.volumeId}`);
      console.log(`   ${chalk.bold('Size:')}        ${s.volume.sizeGb} GB`);
      console.log(`   ${chalk.bold('Mount path:')}  ${s.volume.mountPath}`);
      console.log(`   ${chalk.bold('FS label:')}    ${s.volume.fsLabel}`);
    }

    if (s.nfs) {
      console.log(chalk.cyan('\n🌐 NFS Export\n'));
      console.log(`   ${chalk.bold('Export path:')} ${s.nfs.exportPath}`);
      console.log(
        `   ${chalk.bold('Server opts:')} ${chalk.dim(s.nfs.exportOptions)}`,
      );
      console.log(
        `   ${chalk.bold('Client opts:')} ${chalk.dim(s.nfs.mountOptions)}`,
      );
    }

    if (s.pvcs) {
      console.log(chalk.cyan('\n📂 PersistentVolumeClaims\n'));
      console.log(`   ${chalk.bold('Bound PVCs:')}    ${s.pvcs.bound}`);
      console.log(
        `   ${chalk.bold('Requested:')}     ${s.pvcs.requestedGb} GB`,
      );
      const namespaces = Object.entries(s.pvcs.byNamespace);
      if (namespaces.length > 0) {
        console.log(`   ${chalk.bold('By namespace:')}`);
        const sortedNamespaces = [...namespaces].sort(([a], [b]) =>
          a.localeCompare(b),
        );
        for (const [ns, count] of sortedNamespaces) {
          console.log(`     ${chalk.dim('•')} ${ns}: ${count}`);
        }
      }
    }

    console.log('');
  }

  private formatStatus(status: ClusterStorageStatus): string {
    const map: Record<ClusterStorageStatus, (s: string) => string> = {
      [ClusterStorageStatus.READY]: chalk.green,
      [ClusterStorageStatus.PROVISIONING]: chalk.yellow,
      [ClusterStorageStatus.DEGRADED]: chalk.yellow,
      [ClusterStorageStatus.ERROR]: chalk.red,
      [ClusterStorageStatus.DISABLED]: chalk.dim,
      [ClusterStorageStatus.UNKNOWN]: chalk.white,
    };
    return (map[status] ?? chalk.white)(status);
  }
}
