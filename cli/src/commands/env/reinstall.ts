import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { printContextBanner } from '../../lib/context-banner';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliByosPurgeService } from '../../services/cli-byos-purge.service';
import { confirmByTypingPrompt } from '../../lib/prompts';
import { OperationStatus } from 'src/modules/infrastructure/servers/entities/infrastructure-operations.entity';

export default class EnvReinstall extends Command {
  static readonly description =
    'Reinstall Flui in place on the control cluster’s existing server (cloud-provisioned clusters only) — wipes k3s/Flui state and re-runs the bootstrap over SSH, WITHOUT deleting the VM, its firewall, its VNet attachment or its attached shared-storage volume.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --force',
    '<%= config.bin %> <%= command.id %> --dry-run',
  ];

  static readonly flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description:
        'Print the host teardown script without running it or reinstalling anything.',
      default: false,
    }),
    detached: Flags.boolean({
      char: 'd',
      description:
        'Start reinstall and exit immediately (default: follow logs until done)',
      default: false,
    }),
  };

  private logPath(opId: string): string {
    return path.join(os.homedir(), '.flui', 'logs', `${opId}.log`);
  }

  private printNewLog(p: string, printed: number): number {
    try {
      const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
      if (content.length > printed) {
        process.stdout.write(content.slice(printed));
        return content.length;
      }
    } catch {
      /* log not ready yet */
    }
    return printed;
  }

  private printClusterInfo(cluster: {
    name: string;
    id: string;
    provider: string;
    masterIpAddress?: string;
  }): void {
    console.log(chalk.yellow('\n⚠️  Cluster to be reinstalled:\n'));
    console.log(`   ${chalk.bold('Name:')}     ${cluster.name}`);
    console.log(`   ${chalk.bold('ID:')}       ${cluster.id}`);
    console.log(`   ${chalk.bold('Provider:')} ${cluster.provider}`);
    console.log(`   ${chalk.bold('Master IP:')} ${cluster.masterIpAddress}`);
    console.log(
      chalk.dim(
        '\n   The VM, its firewall, VNet attachment and attached storage volume stay allocated —',
      ),
    );
    console.log(
      chalk.red(
        '   but Flui’s OS-level install and ALL in-cluster data (apps, database, dashboard state) will be wiped and reinstalled.',
      ),
    );
    console.log(
      chalk.dim(
        '   Same data loss as `flui env destroy`, just without losing the server itself.\n',
      ),
    );
  }

  private printDryRun(purgeService: CliByosPurgeService): void {
    console.log(
      chalk.dim('Would run on the master node before reinstalling:\n'),
    );
    console.log(
      chalk.dim(
        purgeService
          .buildScript(false, null)
          .split('\n')
          .map((l) => `   │ ${l}`)
          .join('\n'),
      ),
    );
  }

  /** Follows the operation log until it reaches a terminal status, or times out. */
  private async followOperation(
    controlService: CliControlClusterService,
    clusterId: string,
    operationId: string,
  ): Promise<void> {
    console.log(chalk.dim('\n' + '─'.repeat(80)));
    let printed = 0;
    const deadline = Date.now() + 30 * 60_000;

    while (Date.now() < deadline) {
      const op = await controlService.getClusterOperation(clusterId);
      if (op?.id === operationId) {
        printed = this.printNewLog(this.logPath(op.id), printed);
        if (op.status === OperationStatus.COMPLETED) {
          console.log(chalk.dim('─'.repeat(80)));
          console.log(chalk.green('\n✅ Flui reinstalled on your server!\n'));
          console.log(
            chalk.bold('   Retrieve credentials: ') +
              chalk.cyan('flui env credentials\n'),
          );
          return;
        }
        if (op.status === OperationStatus.FAILED) {
          const err = (op.metadata?.error as string) || 'unknown error';
          console.log(chalk.dim('─'.repeat(80)));
          console.log(chalk.red(`\n❌ Reinstall failed: ${err}\n`));
          console.log(chalk.dim(`   Full log: ${this.logPath(op.id)}\n`));
          this.exit(1);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log(
      chalk.yellow(
        '\n⚠ Timed out waiting for reinstall. Check `flui env status`.\n',
      ),
    );
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvReinstall);

    printContextBanner();
    let spinner = ora('Initializing...').start();
    let app: any;

    try {
      app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      spinner.succeed('Initialized');

      spinner = ora('Checking for cluster...').start();
      let cluster: Awaited<
        ReturnType<typeof controlService.getReinstallableCluster>
      >;
      try {
        cluster = await controlService.getReinstallableCluster();
      } catch (error) {
        spinner.fail('Cluster is not eligible for reinstall');
        console.log(chalk.red(`\n❌ ${(error as Error).message}\n`));
        this.exit(1);
        return;
      }
      if (!cluster) {
        spinner.fail('No control cluster found');
        console.log(chalk.dim('\nCreate one with:'));
        console.log(`   ${chalk.cyan('flui env create')}\n`);
        return;
      }
      spinner.succeed('Cluster found');
      this.printClusterInfo(cluster);

      if (flags['dry-run']) {
        this.printDryRun(app.get(CliByosPurgeService));
        return;
      }

      if (
        !flags.force &&
        !(await confirmByTypingPrompt(
          chalk.yellow('⚠️  Cluster name'),
          cluster.name,
        ))
      ) {
        console.log(chalk.green('\n✅ Cancelled (name did not match)\n'));
        return;
      }

      spinner = ora('Starting reinstall...').start();
      let operationId: string;
      try {
        const result = await controlService.reinstallControlCluster();
        operationId = result.operationId;
        spinner.succeed('Reinstall started');
      } catch (error) {
        spinner.fail('Failed to start reinstall');
        console.log(chalk.red(`\n❌ ${(error as Error).message}\n`));
        this.exit(1);
        return;
      }

      if (flags.detached) {
        console.log(chalk.green('\n✅ Reinstall started in background\n'));
        console.log(
          `   ${chalk.cyan('flui env status')}   - Check reinstall progress`,
        );
        console.log(
          `   ${chalk.cyan('flui env logs')}     - Follow the install log\n`,
        );
        return;
      }

      await this.followOperation(controlService, cluster.id, operationId);
    } finally {
      await closeNestApp();
    }
  }
}
