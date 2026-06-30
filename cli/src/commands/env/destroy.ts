import * as os from 'node:os';
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';
import { INestApplication } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { printContextBanner } from '../../lib/context-banner';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import {
  CliByosPurgeService,
  ByosPurgeTarget,
} from '../../services/cli-byos-purge.service';
import { ConfigStorage } from '../../lib/config-storage';
import { ProfileManager } from '../../lib/profile-manager';
import { confirmByTypingPrompt } from '../../lib/prompts';
import { VnetProvisioningService } from '../../lib/services/vnet-provisioning.service';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { ClusterEntity } from 'src/modules/infrastructure/clusters/entities/cluster.entity';

export default class EnvDestroy extends Command {
  static readonly description =
    'Permanently delete control cluster (WARNING: All data will be lost!)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --force',
    {
      description:
        'BYOS: de-register the cluster but leave Flui running on the host',
      command: '<%= config.bin %> <%= command.id %> --keep-host',
    },
  ];

  static readonly flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    }),
    'purge-host': Flags.boolean({
      description:
        'BYOS: uninstall Flui from the host over SSH (k3s, data, firewall, kubeconfig) — leaving a clean, reinstall-ready machine. This is the DEFAULT for BYOS now; the flag is kept for explicitness. SSH trust is kept so `env create --host` can run again.',
      default: false,
    }),
    'keep-host': Flags.boolean({
      description:
        'BYOS: de-register the cluster but leave Flui running on the host (skip teardown). The host stays dirty — a reinstall on it will fail until cleaned.',
      default: false,
    }),
    'remove-access': Flags.boolean({
      description:
        'BYOS: full decommission — also remove Flui’s SSH CA trust and managed key and re-enable password login, so the host no longer trusts Flui.',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description:
        'BYOS: print the host teardown script without running it or deleting anything.',
      default: false,
    }),
    host: Flags.string({
      description:
        'BYOS purge: target host when no local record exists (orphaned/half-failed install).',
    }),
    user: Flags.string({
      description: 'BYOS purge: SSH user (default: root).',
    }),
    port: Flags.integer({ description: 'BYOS purge: SSH port (default: 22).' }),
    'ssh-key': Flags.string({
      description:
        'BYOS purge: SSH private key (default: the key the install used, else ~/.flui/ssh/id_rsa).',
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

  private resolveKeyPath(flag?: string): string {
    const raw = flag || path.join(os.homedir(), '.flui', 'ssh', 'id_rsa');
    return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  }

  private resolvePurgeTarget(
    byos:
      | { host?: string; port?: number; user?: string; keyPath?: string }
      | undefined,
    flags: Record<string, unknown>,
  ): ByosPurgeTarget | null {
    const host = (flags.host as string) || byos?.host;
    if (!host) return null;
    return {
      host,
      port: (flags.port as number) ?? byos?.port ?? 22,
      user: (flags.user as string) || byos?.user || 'root',
      keyPath: this.resolveKeyPath(
        (flags['ssh-key'] as string) || byos?.keyPath,
      ),
    };
  }

  private printPurgeWarning(removeAccess: boolean): void {
    console.log(
      chalk.red(
        '\n   ⚠️  --purge-host UNINSTALLS Flui from the machine and DELETES ALL APP DATA',
      ),
    );
    console.log(
      chalk.dim(
        '   (k3s, Postgres, volumes/PVs, observability) — this is irreversible.',
      ),
    );
    if (removeAccess) {
      console.log(
        chalk.dim(
          '   --remove-access: also removes Flui’s SSH CA + managed key; password login is re-enabled.',
        ),
      );
    } else {
      console.log(
        chalk.dim(
          '   SSH trust is kept so you can re-run `flui env create --host`.',
        ),
      );
    }
    console.log('');
  }

  private async runHostPurge(
    app: INestApplication,
    target: ByosPurgeTarget,
    removeAccess: boolean,
    dryRun: boolean,
  ): Promise<void> {
    const purgeService = app.get(CliByosPurgeService);
    if (dryRun) {
      console.log(
        chalk.dim(
          `\n   Would run on ${target.user}@${target.host}:${target.port}:\n`,
        ),
      );
      const script = purgeService.buildScript(
        removeAccess,
        removeAccess ? '<flui-managed-pubkey>' : null,
      );
      console.log(
        chalk.dim(
          script
            .split('\n')
            .map((l) => `   │ ${l}`)
            .join('\n'),
        ),
      );
      return;
    }
    console.log(chalk.dim(`\n   Uninstalling Flui from ${target.host}...`));
    try {
      const res = await purgeService.purgeHost(target, {
        removeAccess,
        onData: (c) => process.stdout.write(chalk.dim(c)),
      });
      for (const w of res.warnings) console.log(chalk.yellow(`   ⚠ ${w}`));
      console.log(
        chalk.green(
          removeAccess
            ? '   ✅ Host uninstalled and Flui SSH trust removed'
            : '   ✅ Host uninstalled (SSH trust kept — reinstall-ready)',
        ),
      );
    } catch (e) {
      console.log(
        chalk.yellow(
          `   ⚠ Host purge failed: ${(e as Error).message}\n   Local records are still removed; clean the host manually if needed.`,
        ),
      );
    }
  }

  private async runOrphanPurge(
    app: INestApplication,
    flags: Record<string, unknown>,
  ): Promise<void> {
    const target = this.resolvePurgeTarget(undefined, flags);
    if (!target) return;
    const removeAccess = !!flags['remove-access'];
    const dryRun = !!flags['dry-run'];
    console.log(chalk.red('\n⚠️  Purge Flui from host (no local record)\n'));
    console.log(
      `   ${chalk.bold('Host:')} ${target.user}@${target.host}:${target.port}`,
    );
    this.printPurgeWarning(removeAccess);
    if (!flags.force && !dryRun) {
      const confirmed = await confirmByTypingPrompt(
        chalk.yellow('⚠️  Host'),
        target.host,
      );
      if (!confirmed) {
        console.log(chalk.green('\n✅ Cancelled (host did not match)\n'));
        return;
      }
    }
    await this.runHostPurge(app, target, removeAccess, dryRun);
  }

  private printClusterInfo(cluster: ClusterEntity): void {
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
  }

  private preparePurge(
    cluster: ClusterEntity,
    flags: Record<string, unknown>,
  ): ByosPurgeTarget | null {
    if ((cluster.provider as CloudProvider) !== CloudProvider.BYOS) {
      console.log(
        chalk.yellow(
          '\n   ⚠ --purge-host is BYOS-only; ignoring (cloud servers are deleted at the provider).',
        ),
      );
      return null;
    }
    const byos = (
      cluster.metadata as
        | {
            byos?: {
              host?: string;
              port?: number;
              user?: string;
              keyPath?: string;
            };
          }
        | undefined
    )?.byos;
    const target = this.resolvePurgeTarget(byos, flags);
    if (!target) {
      console.log(
        chalk.yellow(
          '\n   ⚠ No SSH target for host purge (missing byos metadata); pass --host.',
        ),
      );
      return null;
    }
    this.printPurgeWarning(!!flags['remove-access']);
    return target;
  }

  private async confirmName(name: string): Promise<boolean> {
    console.log('');
    console.log(
      chalk.yellow(
        `   To confirm, type the cluster name exactly: ${chalk.bold(name)}`,
      ),
    );
    return confirmByTypingPrompt(chalk.yellow('⚠️  Cluster name'), name);
  }

  private snapshotContext(): void {
    try {
      const snap = ProfileManager.snapshotActiveProfile();
      if (snap) {
        console.log(
          chalk.dim(
            `   🛟  Local context backed up to ${snap.path} (${snap.fileCount} files)`,
          ),
        );
      }
    } catch (error) {
      console.log(
        chalk.yellow(
          `   ⚠️  Could not back up local context: ${(error as Error).message}`,
        ),
      );
      console.log(chalk.yellow('   Continuing with destroy...'));
    }
  }

  private async finalizeDestroy(
    app: INestApplication,
    controlService: CliControlClusterService,
    hostPurged: boolean,
  ): Promise<void> {
    console.log('');
    let spinner = ora({
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

    try {
      spinner = ora('Removing environment VNet...').start();
      const vnetService = app.get(VnetProvisioningService);
      await vnetService.destroyEnvVnet();
      spinner.succeed('Environment VNet removed');
    } catch (error) {
      spinner.warn(`VNet teardown failed: ${(error as Error).message}`);
      console.log(
        chalk.yellow(
          '   You may need to delete the VNet manually from the provider console.',
        ),
      );
    }

    console.log(chalk.green('\n✅ Control Cluster Deleted Successfully\n'));
    console.log(chalk.dim('   Removed:'));
    if (hostPurged) {
      console.log(
        chalk.dim('   • Flui uninstalled from the host (k3s, data, firewall)'),
      );
    }
    console.log(chalk.dim('   • Servers / records and bootstrap credentials'));
    console.log(chalk.dim('   • Environment VNet/Subnet (cloud)'));
    console.log(chalk.dim('   • Local configuration\n'));
  }

  private async handleMissingCluster(
    app: INestApplication,
    flags: Record<string, unknown>,
  ): Promise<void> {
    if (flags.host) {
      await this.runOrphanPurge(app, flags);
      return;
    }
    console.log(chalk.yellow('\n⚠️  No control cluster exists.\n'));
    console.log(chalk.dim('Create one with:'));
    console.log(`   ${chalk.cyan('flui env create')}\n`);
  }

  private async handleDryRun(
    app: INestApplication,
    purgeTarget: ByosPurgeTarget | null,
    removeAccess: boolean,
  ): Promise<void> {
    if (purgeTarget) {
      await this.runHostPurge(app, purgeTarget, removeAccess, true);
      return;
    }
    console.log(
      chalk.dim('\n   --dry-run applies only to BYOS host teardown.\n'),
    );
  }

  private reportDestroyError(error: unknown): void {
    console.log(chalk.red('\n❌ Error:\n'));
    if (error instanceof Error) {
      console.log(`   ${error.message}`);
      if (error.message.includes('not found')) {
        console.log(chalk.yellow('\n💡 Hint:'));
        console.log(`   The cluster may have already been deleted.`);
        console.log(`   Check with: ${chalk.cyan('flui env status')}\n`);
      }
    } else {
      console.log('  ', error);
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
        spinner.stop();
        await this.handleMissingCluster(app, flags);
        return;
      }

      spinner.succeed('Cluster found');

      // BYOS has no provider servers to delete, so destroy cleans the host
      // itself (else a reinstall on it fails); --keep-host opts out.
      const isByos = (cluster.provider as CloudProvider) === CloudProvider.BYOS;
      const wantPurge = isByos
        ? !flags['keep-host']
        : !!(flags['purge-host'] || flags['remove-access']);

      this.printClusterInfo(cluster);

      const purgeTarget = wantPurge ? this.preparePurge(cluster, flags) : null;

      if (flags['dry-run']) {
        await this.handleDryRun(app, purgeTarget, !!flags['remove-access']);
        return;
      }

      if (!flags.force && !(await this.confirmName(cluster.name))) {
        console.log(
          chalk.green('\n✅ Deletion cancelled (name did not match)\n'),
        );
        return;
      }

      this.snapshotContext();

      if (purgeTarget) {
        await this.runHostPurge(
          app,
          purgeTarget,
          !!flags['remove-access'],
          false,
        );
      }

      await this.finalizeDestroy(app, controlService, !!purgeTarget);
    } catch (error) {
      spinner.fail('Failed to destroy cluster');
      this.reportDestroyError(error);
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
