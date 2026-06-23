import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { printContextBanner } from '../../lib/context-banner';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliClusterRepository } from '../../lib/repositories/cli-cluster.repository';
import { CliSshService } from '../../services/cli-ssh.service';
import { ClusterEntity } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import {
  resolveClusterSshTarget,
  SshTarget,
} from '../../lib/cluster-ssh-target';

const CP_LABEL = 'node-role.kubernetes.io/control-plane';
const APPLY_CMD = `kubectl taint nodes -l ${CP_LABEL} ${CP_LABEL}=:NoSchedule --overwrite`;
const REMOVE_CMD = `kubectl taint nodes -l ${CP_LABEL} ${CP_LABEL}:NoSchedule- 2>/dev/null || true`;
const TAINT_KEYS_CMD = `kubectl get nodes -l ${CP_LABEL} -o jsonpath='{.items[*].spec.taints[*].key}'`;
const WORKER_COUNT_CMD = `kubectl get nodes -l '!${CP_LABEL}' --no-headers 2>/dev/null | wc -l`;

export default class EnvSetMasterProtection extends Command {
  static readonly description =
    'Taint the control-cluster master so new pods schedule on workers (on), ' +
    'remove it (off), or report current state (show).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> on',
    '<%= config.bin %> <%= command.id %> off',
    '<%= config.bin %> <%= command.id %> show',
  ];

  static readonly args = {
    action: Args.string({
      description: 'on | off | show',
      required: true,
      options: ['on', 'off', 'show'],
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(EnvSetMasterProtection);
    printContextBanner();
    const spinner = ora('Resolving control cluster...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const clusterRepo = app.get(CliClusterRepository);
      const ssh = app.get(CliSshService);

      const cluster = await controlService.getControlCluster();
      if (!cluster) {
        spinner.fail('No control cluster found');
        this.exit(1);
      }
      const masterIp = cluster.masterIpAddress;
      if (!masterIp) {
        spinner.fail('Control cluster has no masterIpAddress stored');
        this.exit(1);
      }

      const sshT = resolveClusterSshTarget(cluster, masterIp);

      // Worker count comes from the live cluster, not the local profile (which
      // can drift out of sync with the backend).
      const workers = await this.countWorkers(ssh, sshT);

      if (args.action === 'show') {
        await this.showState(spinner, ssh, cluster, sshT, workers);
        return;
      }
      if (args.action === 'on') {
        await this.turnOn(spinner, ssh, clusterRepo, cluster, sshT, workers);
        return;
      }
      await this.turnOff(spinner, ssh, clusterRepo, cluster, sshT);
    } catch (error) {
      spinner.fail('set-master-protection failed');
      console.log(
        chalk.red(
          `\n❌ ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private async countWorkers(
    ssh: CliSshService,
    t: SshTarget,
  ): Promise<number> {
    const out = await ssh.sshExec(t.host, WORKER_COUNT_CMD, t.user, t.port);
    return Number.parseInt(out.trim(), 10) || 0;
  }

  private async masterTainted(
    ssh: CliSshService,
    t: SshTarget,
  ): Promise<boolean> {
    const out = await ssh.sshExec(t.host, TAINT_KEYS_CMD, t.user, t.port);
    return out.includes(CP_LABEL);
  }

  private protectionLabel(workers: number, tainted: boolean): string {
    if (workers === 0) return chalk.dim('n/a (single-node)');
    return tainted ? chalk.green('on (master tainted)') : chalk.yellow('off');
  }

  private async showState(
    spinner: Ora,
    ssh: CliSshService,
    cluster: ClusterEntity,
    t: SshTarget,
    workers: number,
  ): Promise<void> {
    const tainted = await this.masterTainted(ssh, t);
    spinner.stop();
    const flag = cluster.metadata?.masterProtection;
    console.log(chalk.cyan('\n  Master protection\n'));
    console.log(`  State:        ${this.protectionLabel(workers, tainted)}`);
    console.log(
      `  Stored flag:  ${flag === undefined ? chalk.dim('unset') : String(flag)}`,
    );
    console.log(`  Workers:      ${workers}\n`);
  }

  private async turnOn(
    spinner: Ora,
    ssh: CliSshService,
    clusterRepo: CliClusterRepository,
    cluster: ClusterEntity,
    t: SshTarget,
    workers: number,
  ): Promise<void> {
    if (workers === 0) {
      spinner.fail(
        'Cannot protect the master on a single-node cluster — it would block all scheduling. Add a worker first.',
      );
      this.exit(1);
    }
    spinner.text = 'Tainting master via SSH...';
    await ssh.sshExec(t.host, APPLY_CMD, t.user, t.port);
    await this.persist(clusterRepo, cluster, true);
    spinner.succeed('Master protection enabled');
    console.log(
      chalk.dim(
        '\n  New pods will schedule on workers. Existing pods on the master are not evicted.\n',
      ),
    );
  }

  private async turnOff(
    spinner: Ora,
    ssh: CliSshService,
    clusterRepo: CliClusterRepository,
    cluster: ClusterEntity,
    t: SshTarget,
  ): Promise<void> {
    spinner.text = 'Removing master taint via SSH...';
    await ssh.sshExec(t.host, REMOVE_CMD, t.user, t.port);
    await this.persist(clusterRepo, cluster, false);
    spinner.succeed('Master protection disabled');
    console.log(
      chalk.dim('\n  The master is schedulable again for new pods.\n'),
    );
  }

  private async persist(
    clusterRepo: CliClusterRepository,
    cluster: ClusterEntity,
    enabled: boolean,
  ): Promise<void> {
    cluster.metadata = { ...cluster.metadata, masterProtection: enabled };
    await clusterRepo.save(cluster);
  }
}
