import { Command, Flags } from '@oclif/core';
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

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --usage',
  ];

  static readonly flags = {
    usage: Flags.boolean({
      default: false,
      description:
        'Also measure how much disk each application and each user really takes. Runs a short job on every node, so it takes a few seconds.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvStorage);
    printContextBanner();
    const spinner = ora('Inspecting shared storage...').start();

    try {
      const { cluster, api } = await openControlPlane(await getNestApp());
      const status = await api.get<ClusterStorageStatusDto>(
        `/infrastructure/clusters/${cluster.id}/storage`,
      );
      spinner.succeed('Storage status retrieved');
      this.render(status);

      if (flags.usage) {
        const measuring = ora(
          'Measuring what each application uses...',
        ).start();
        const usage = await api.get<ClusterStorageUsage>(
          `/infrastructure/clusters/${cluster.id}/storage/usage`,
        );
        measuring.succeed(
          `Measured on ${usage.nodes.length} node${usage.nodes.length === 1 ? '' : 's'}`,
        );
        this.renderUsage(usage);
      }
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

  private renderUsage(u: ClusterStorageUsage): void {
    for (const miss of u.unreachable) {
      console.log(chalk.yellow(`   ⚠ ${miss.node}: ${miss.reason}`));
    }

    if (u.volumes.length === 0) {
      console.log(
        chalk.dim('\n   No application volumes on this cluster yet.\n'),
      );
      return;
    }

    console.log(chalk.cyan('\n👤 Used by each user\n'));
    for (const row of u.byNamespace) {
      console.log(
        `   ${row.namespace.padEnd(28)} ${bytes(row.bytes).padStart(10)}  ${chalk.dim(
          `${row.volumes} volume${row.volumes === 1 ? '' : 's'}`,
        )}`,
      );
    }

    console.log(chalk.cyan('\n📊 Used by each volume\n'));
    for (const v of u.volumes) {
      const where = v.kind === 'local' ? "node's disk" : 'shared';
      console.log(
        `   ${v.volumeName.padEnd(44)} ${bytes(v.bytes).padStart(10)}  ${chalk.dim(
          `${v.namespace} · ${where}`,
        )}`,
      );
    }

    console.log('');
    console.log(
      `   ${chalk.bold('On the nodes’ own disks:')} ${bytes(u.totals.local)}`,
    );
    console.log(
      `   ${chalk.bold('On the shared volume:')}    ${bytes(u.totals.shared)}`,
    );
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

interface ClusterStorageUsage {
  measuredAt: string;
  nodes: string[];
  unreachable: Array<{ node: string; reason: string }>;
  volumes: Array<{
    volumeName: string;
    namespace: string;
    kind: 'local' | 'shared';
    node: string;
    bytes: number;
  }>;
  byNamespace: Array<{ namespace: string; bytes: number; volumes: number }>;
  totals: { local: number; shared: number };
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
