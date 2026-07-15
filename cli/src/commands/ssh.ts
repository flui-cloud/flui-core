import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../lib/nest-app';
import { CliSshService } from '../services/cli-ssh.service';
import { resolveSshTarget } from '../lib/resolve-ssh-target';

export default class Ssh extends Command {
  static readonly description = 'SSH into a cluster node';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> master',
    '<%= config.bin %> <%= command.id %> worker-1',
    '<%= config.bin %> <%= command.id %> control-cluster/master',
    '<%= config.bin %> <%= command.id %> workload-cluster-1/master',
    '<%= config.bin %> <%= command.id %> workload-cluster-1/worker-1',
  ];

  static readonly args = {
    node: Args.string({
      description:
        'Node to SSH into, as <cluster>/<node> (e.g. my-cluster/master, my-cluster/worker-1). ' +
        'A bare node name (master, worker-1) targets the control cluster.',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Ssh);
    const spinner = ora('Connecting to cluster...').start();

    try {
      const app = await getNestApp();
      const sshService = app.get(CliSshService);

      const { target, clusterName, nodeLabel } = await resolveSshTarget(
        args.node,
      );

      spinner.succeed(`Connecting to ${nodeLabel} of ${clusterName}...`);
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
