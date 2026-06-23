import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../lib/nest-app';
import { CliControlClusterService } from '../services/cli-control-cluster.service';
import { CliSshService } from '../services/cli-ssh.service';
import { resolveClusterSshTarget } from '../lib/cluster-ssh-target';

export default class Ssh extends Command {
  static readonly description = 'SSH into a cluster node';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> master',
    '<%= config.bin %> <%= command.id %> worker-1',
    '<%= config.bin %> <%= command.id %> worker-2',
  ];

  static readonly args = {
    node: Args.string({
      description: 'Node to SSH into (master, worker-1, worker-2, etc.)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Ssh);
    const spinner = ora('Connecting to cluster...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const sshService = app.get(CliSshService);

      // Get cluster
      const cluster = await controlService.getControlCluster();

      if (!cluster) {
        spinner.fail('No control cluster found');
        console.log(chalk.yellow('\n⚠️  No control cluster exists.\n'));
        console.log(chalk.dim('Create one with:'));
        console.log(`   ${chalk.cyan('flui env create')}\n`);
        return;
      }

      // Get node IP
      let nodeIp: string | undefined;
      let nodeName: string;

      if (args.node === 'master') {
        nodeIp = cluster.masterIpAddress;
        nodeName = 'Master Node';
      } else {
        // Find worker node
        const workerIndex = Number.parseInt(args.node.replace('worker-', ''));
        if (Number.isNaN(workerIndex)) {
          spinner.fail('Invalid node name');
          console.log(chalk.red(`\n❌ Invalid node name: ${args.node}\n`));
          console.log(
            chalk.dim('Valid options: master, worker-1, worker-2, etc.\n'),
          );
          return;
        }

        const workerNode = cluster.nodes?.find(
          (n) =>
            n.nodeType === 'worker' &&
            n.serverName.includes(`worker-${workerIndex}`),
        );

        if (!workerNode) {
          spinner.fail('Worker node not found');
          console.log(chalk.red(`\n❌ Worker node ${args.node} not found\n`));
          return;
        }

        nodeIp = workerNode.ipAddress;
        nodeName = `Worker Node ${workerIndex}`;
      }

      if (!nodeIp) {
        spinner.fail('Node IP not available');
        console.log(
          chalk.red(`\n❌ Node ${args.node} does not have an IP address yet\n`),
        );
        console.log(
          chalk.dim('The node may still be provisioning. Check status with:'),
        );
        console.log(`   ${chalk.cyan('flui env status')}\n`);
        return;
      }

      const target =
        args.node === 'master'
          ? resolveClusterSshTarget(cluster, nodeIp)
          : { host: nodeIp, port: 22, user: 'root' };

      spinner.succeed(`Connecting to ${nodeName}...`);
      const portSuffix = target.port === 22 ? '' : ` -p ${target.port}`;
      console.log(
        chalk.dim(`   SSH: ${target.user}@${target.host}${portSuffix}`),
      );

      const exitHint =
        process.platform === 'win32'
          ? chalk.dim(`   Type ${chalk.white('exit')} to disconnect\n`)
          : chalk.dim(
              `   Type ${chalk.white('exit')} or press ${chalk.white('Ctrl+D')} to disconnect\n`,
            );
      console.log(exitHint);

      // SSH into the node
      await sshService.sshConnect(target.host, target.user, target.port);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spinner.fail('SSH connection failed');
      console.log(chalk.red(`\n❌ ${message}\n`));
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
