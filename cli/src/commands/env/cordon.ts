import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { printContextBanner } from '../../lib/context-banner';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliNodeRepository } from '../../lib/repositories/cli-node.repository';
import { NodeType } from 'src/modules/infrastructure/clusters/entities/cluster-node.entity';
import { CliSshService } from '../../services/cli-ssh.service';
import { resolveClusterSshTarget } from '../../lib/cluster-ssh-target';

export default class EnvCordon extends Command {
  static readonly description =
    'Mark a cluster node unschedulable so it stops accepting new workloads. ' +
    'Use before planned maintenance on a node; re-open it afterwards with `flui env uncordon`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> master',
    '<%= config.bin %> <%= command.id %> worker-1',
  ];

  static readonly args = {
    target: Args.string({
      description: 'Node target: "master" or a worker node serverName',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(EnvCordon);
    printContextBanner();
    const spinner = ora('Resolving node...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const nodeRepo = app.get(CliNodeRepository);
      const ssh = app.get(CliSshService);

      const cluster = await controlService.getControlCluster();
      if (!cluster) {
        spinner.fail('No control cluster found');
        return;
      }
      const nodes = await nodeRepo.find({ where: { clusterId: cluster.id } });
      const target =
        args.target === 'master'
          ? nodes.find((n) => n.nodeType === NodeType.MASTER)
          : nodes.find((n) => n.serverName === args.target);
      if (!target) {
        spinner.fail(`Node "${args.target}" not found`);
        this.exit(1);
      }
      if (!cluster.masterIpAddress) {
        spinner.fail('Cluster has no masterIpAddress stored');
        this.exit(1);
      }

      spinner.text = `Cordoning ${target.serverName} via SSH to master...`;
      const sshT = resolveClusterSshTarget(cluster, cluster.masterIpAddress);
      const out = await ssh.sshExec(
        sshT.host,
        `kubectl cordon ${target.serverName}`,
        sshT.user,
        sshT.port,
      );
      spinner.succeed(
        `Node ${target.serverName} is now unschedulable (existing pods keep running)`,
      );
      if (out.trim()) {
        console.log(chalk.dim(`   ${out.trim()}`));
      }
      console.log(
        chalk.dim(`   Re-open with: flui env uncordon ${target.serverName}`),
      );
      console.log('');
    } catch (error) {
      spinner.fail('Cordon failed');
      console.log(chalk.red('\n❌ Error:\n'));
      console.log(
        `   ${error instanceof Error ? error.message : String(error)}\n`,
      );
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
