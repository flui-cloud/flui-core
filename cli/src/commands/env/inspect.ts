import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliSshService } from '../../services/cli-ssh.service';
import { printContextBanner } from '../../lib/context-banner';
import { resolveClusterSshTarget } from '../../lib/cluster-ssh-target';

export default class EnvInspect extends Command {
  static readonly description = 'Inspect remote cluster logs via SSH';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --node master',
    '<%= config.bin %> <%= command.id %> --node worker-1 --log cloud-init',
    '<%= config.bin %> <%= command.id %> --follow',
    '<%= config.bin %> <%= command.id %> -f --log k3s',
  ];

  static readonly flags = {
    node: Flags.string({
      char: 'n',
      description: 'Node to inspect (master, worker-1, worker-2, etc.)',
      default: 'master',
    }),
    log: Flags.string({
      char: 'l',
      description: 'Log file to view',
      options: ['cloud-init', 'cloud-init-output', 'k3s', 'syslog'],
      default: 'cloud-init-output',
    }),
    tail: Flags.integer({
      char: 't',
      description: 'Number of lines to show',
      default: 100,
    }),
    follow: Flags.boolean({
      char: 'f',
      description: 'Follow log output in real-time (like tail -f)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvInspect);
    printContextBanner();
    let spinner = ora('Loading cluster information...').start();

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

      spinner.succeed('Cluster found');

      // Get node IP
      let nodeIp: string | undefined;
      let nodeName: string;

      if (flags.node === 'master') {
        nodeIp = cluster.masterIpAddress;
        nodeName = 'Master Node';
      } else {
        // Find worker node
        const workerIndex = Number.parseInt(flags.node.replace('worker-', ''));
        if (Number.isNaN(workerIndex)) {
          console.log(chalk.red(`\n❌ Invalid node name: ${flags.node}\n`));
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
          console.log(chalk.red(`\n❌ Worker node ${flags.node} not found\n`));
          return;
        }

        nodeIp = workerNode.ipAddress;
        nodeName = `Worker Node ${workerIndex}`;
      }

      if (!nodeIp) {
        console.log(
          chalk.red(
            `\n❌ Node ${flags.node} does not have an IP address yet\n`,
          ),
        );
        console.log(
          chalk.dim('The node may still be provisioning. Check status with:'),
        );
        console.log(`   ${chalk.cyan('flui env status')}\n`);
        return;
      }

      const target =
        flags.node === 'master'
          ? resolveClusterSshTarget(cluster, nodeIp)
          : { host: nodeIp, port: 22, user: 'root' };

      // Determine log file path
      const logPaths: Record<string, string> = {
        'cloud-init': '/var/log/cloud-init.log',
        'cloud-init-output': '/var/log/cloud-init-output.log',
        k3s: '/var/log/k3s.log',
        syslog: '/var/log/syslog',
      };

      const logPath = logPaths[flags.log];

      // Handle follow mode vs one-time fetch
      if (flags.follow) {
        // FOLLOW MODE: Stream logs in real-time
        spinner.succeed(`Cluster found - streaming logs from ${nodeName}`);

        // Display header
        console.log(
          chalk.cyan(`\n📋 ${nodeName} - ${flags.log} (following)\n`),
        );
        console.log(chalk.dim(`   Node: ${flags.node} (${nodeIp})`));
        console.log(chalk.dim(`   Log: ${logPath}`));
        console.log(chalk.dim(`   Press Ctrl+C to stop\n`));
        console.log(chalk.dim('─'.repeat(80)));

        let cleanup: (() => void) | null = null;

        // Setup signal handler for graceful exit
        const exitHandler = () => {
          console.log(chalk.dim('\n\n─'.repeat(80)));
          console.log(chalk.yellow('\n⏹  Stopping log stream...\n'));
          if (cleanup) {
            cleanup();
          }
          process.exit(0);
        };

        process.on('SIGINT', exitHandler);
        process.on('SIGTERM', exitHandler);

        try {
          // Start streaming logs
          const stream = await sshService.streamRemoteLog(
            target.host,
            logPath,
            target.user,
            target.port,
          );
          cleanup = stream.cleanup;

          // Keep process alive while streaming
          await new Promise(() => {
            // This promise never resolves - keeps process running until SIGINT
          });
        } catch (error) {
          console.log(chalk.red('\n❌ SSH Stream Error:\n'));
          console.log(`   ${error.message}\n`);
          console.log(chalk.yellow('Troubleshooting:'));
          console.log('   - Ensure the node is fully provisioned');
          console.log('   - Check firewall rules allow SSH');
          console.log('   - Verify SSH keys are correctly configured\n');
          this.exit(1);
        }
      } else {
        // ONE-TIME MODE: Fetch logs once (original behavior)
        spinner = ora(`Fetching ${flags.log} logs from ${nodeName}...`).start();

        try {
          const logs = await sshService.tailRemoteLog(
            target.host,
            logPath,
            flags.tail,
            target.user,
            target.port,
          );
          spinner.succeed(`Logs fetched from ${nodeName}`);

          // Display logs
          console.log(chalk.cyan(`\n📋 ${nodeName} - ${flags.log}\n`));
          console.log(chalk.dim(`   Node: ${flags.node} (${nodeIp})`));
          console.log(chalk.dim(`   Log: ${logPath}`));
          console.log(chalk.dim(`   Lines: ${flags.tail}\n`));
          console.log(chalk.dim('─'.repeat(80)));
          console.log(logs);
          console.log(chalk.dim('─'.repeat(80)));
          console.log('');

          // Show SSH hint
          console.log(chalk.dim('💡 For interactive SSH access:'));
          const sshCmd = chalk.cyan(`flui ssh ${flags.node}`);
          console.log(`   ${sshCmd}\n`);
          console.log(chalk.dim('💡 For real-time log streaming:'));
          const followCmd = chalk.cyan('flui env inspect --follow');
          console.log(`   ${followCmd}\n`);
        } catch (error) {
          spinner.fail('Failed to fetch logs');
          console.log(chalk.red('\n❌ SSH Error:\n'));
          console.log(`   ${error.message}\n`);
          console.log(chalk.yellow('Troubleshooting:'));
          console.log('   - Ensure the node is fully provisioned');
          console.log('   - Check firewall rules allow SSH');
          console.log('   - Verify SSH keys are correctly configured\n');
        }
      }
    } catch (error) {
      spinner.fail('Failed to inspect cluster');
      console.log(chalk.red('\n❌ Error:\n'));
      if (error instanceof Error) {
        console.log(`   ${error.message}\n`);
      } else {
        console.log(`   ${String(error)}\n`);
      }
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
