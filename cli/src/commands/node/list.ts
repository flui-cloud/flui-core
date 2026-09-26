import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliNodeService } from '../../lib/services/cli-node.service';
import { resolveCluster } from '../../lib/resolve-cluster';

export default class NodeList extends Command {
  static readonly description =
    'List all nodes in the cluster (master + workers)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --output json',
  ];

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(NodeList);
    const spinner = ora('Fetching nodes...').start();

    try {
      const { id: clusterId, entity } = await resolveCluster(flags.cluster);
      const service = await CliNodeService.create(clusterId);
      const nodes = await service.listNodes();

      const isControlCluster =
        entity?.clusterType === 'control' ||
        entity?.clusterType === 'observability';
      const master = nodes.find((n) => n.nodeType === 'master');
      const masterProtected =
        typeof master?.takesNewApps === 'boolean'
          ? !master.takesNewApps
          : !!entity?.metadata?.masterProtection;

      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(nodes, null, 2));
        return;
      }

      if (nodes.length === 0) {
        console.log(chalk.yellow('\n  No nodes found.\n'));
        return;
      }

      console.log(chalk.cyan('\n  Cluster Nodes\n'));
      console.log(
        chalk.dim(
          `  ${'ID'.padEnd(38)} ${'ROLE'.padEnd(10)} ${'STATUS'.padEnd(12)} ${'IP'.padEnd(18)} NAME`,
        ),
      );
      console.log(chalk.dim('  ' + '─'.repeat(96)));

      for (const node of nodes) {
        const name =
          node.serverName.length > 30
            ? node.serverName.slice(0, 29) + '…'
            : node.serverName;
        const role = node.nodeType;
        const roleColored =
          role === 'master'
            ? chalk.magenta(role.padEnd(10))
            : chalk.dim(role.padEnd(10));
        const statusPadded = (node.status || 'unknown').padEnd(12);
        const statusColored = this.colorStatus(statusPadded);
        const ip = (node.ipAddress || '-').padEnd(18);
        const taint =
          node.nodeType === 'master' && masterProtected
            ? chalk.yellow('  🔒 control-plane:NoSchedule')
            : '';

        console.log(
          `  ${node.id.padEnd(38)} ${roleColored} ${statusColored} ${ip} ${name}${taint}`,
        );
      }

      const workers = nodes.filter((n) => n.nodeType === 'worker').length;
      console.log('');
      console.log(
        chalk.dim(
          `  ${nodes.length} node${nodes.length === 1 ? '' : 's'} total (1 master, ${workers} worker${workers === 1 ? '' : 's'})`,
        ),
      );

      if (isControlCluster) {
        console.log(
          chalk.dim('  Master protection: ') +
            this.masterProtectionLabel(workers, masterProtected),
        );
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to fetch nodes');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private masterProtectionLabel(
    workers: number,
    protectedFlag: boolean,
  ): string {
    if (workers === 0) return chalk.dim('n/a (single-node)');
    return protectedFlag
      ? chalk.green('auto (master tainted)')
      : chalk.yellow('off');
  }

  private colorStatus(status: string): string {
    const s = status.trim().toLowerCase();
    if (s === 'ready') return chalk.green(status);
    if (s === 'notready' || s === 'not_ready') return chalk.red(status);
    if (s === 'creating' || s === 'provisioning') return chalk.blue(status);
    return chalk.dim(status);
  }
}
