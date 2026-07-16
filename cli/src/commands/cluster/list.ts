import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { isControlClusterType } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { ClusterSummary, listClusters } from '../../lib/cluster-listing';

export default class ClusterList extends Command {
  static readonly description =
    'List every cluster of this installation. Workload clusters exist only in ' +
    'the control cluster database, so they are listed over the API — unlike the ' +
    'control cluster, which this CLI also stores locally.';

  static readonly summary = 'List all clusters';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --output json',
  ];

  static readonly flags = {
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ClusterList);
    const spinner = ora('Fetching clusters...').start();

    const { clusters, apiError } = await listClusters();
    spinner.stop();

    if (flags.output === 'json') {
      console.log(
        JSON.stringify(
          {
            clusters: clusters.map((c) => toReportedCluster(c)),
            apiError: apiError ?? null,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (clusters.length === 0) {
      const why = apiError ? ` (API lookup failed: ${apiError})` : '';
      console.log(chalk.yellow(`\n  No clusters found${why}.\n`));
      console.log(chalk.dim('  Create one with `flui env create`.\n'));
      return;
    }

    console.log(chalk.cyan('\n  Clusters\n'));
    console.log(
      chalk.dim(
        `  ${'NAME'.padEnd(22)} ${'TYPE'.padEnd(10)} ${'PROVIDER'.padEnd(10)} ` +
          `${'REGION'.padEnd(8)} ${'NODES'.padEnd(6)} ${'STATUS'.padEnd(10)} ID`,
      ),
    );
    console.log(chalk.dim('  ' + '─'.repeat(110)));

    for (const cluster of sortClusters(clusters)) {
      this.printRow(cluster);
    }

    console.log('');
    console.log(
      chalk.dim(
        `  ${clusters.length} cluster${clusters.length === 1 ? '' : 's'}`,
      ),
    );
    if (apiError) {
      console.log(
        chalk.yellow(
          `  Workload clusters could not be listed: ${apiError}\n` +
            '  Showing locally-stored clusters only.',
        ),
      );
    }
    console.log('');
  }

  private printRow(cluster: ClusterSummary): void {
    const type = isControlClusterType(cluster.clusterType)
      ? 'control'
      : 'workload';
    const nodes = cluster.nodeCount ?? cluster.nodes?.length;

    console.log(
      `  ${chalk.white(cluster.name.padEnd(22))} ` +
        `${chalk.dim(type.padEnd(10))} ` +
        `${(cluster.provider ?? '—').padEnd(10)} ` +
        `${(cluster.region ?? '—').padEnd(8)} ` +
        `${String(nodes ?? '—').padEnd(6)} ` +
        `${paintStatus(cluster.status ?? '—', 10)} ` +
        chalk.dim(cluster.id),
    );
  }
}

/** Pads before colouring: padEnd would otherwise count chalk's escape codes. */
function paintStatus(status: string, width: number): string {
  const padded = status.padEnd(width);
  if (status === 'ready') return chalk.green(padded);
  if (status === 'error' || status === 'deleting') return chalk.red(padded);
  if (status === '—') return chalk.dim(padded);
  return chalk.yellow(padded);
}

/**
 * The locally-stored clusters carry the encrypted kubeconfig, the K3s token and
 * per-cluster secrets under `metadata`. None of that belongs on stdout, where it
 * can be redirected or pasted, so the reported shape is an explicit allowlist.
 */
function toReportedCluster(cluster: ClusterSummary) {
  return {
    id: cluster.id,
    name: cluster.name,
    clusterType: cluster.clusterType,
    provider: cluster.provider,
    region: cluster.region,
    nodeSize: cluster.nodeSize,
    nodeCount: cluster.nodeCount ?? cluster.nodes?.length,
    status: cluster.status,
    k3sVersion: cluster.k3sVersion,
    masterIpAddress: cluster.masterIpAddress,
    nodes: (cluster.nodes ?? []).map((node) => ({
      serverName: node.serverName,
      nodeType: node.nodeType,
      ipAddress: node.ipAddress,
      status: node.status,
    })),
  };
}

/** Control cluster first — it is the one a bare `flui ssh master` addresses. */
function sortClusters(clusters: ClusterSummary[]): ClusterSummary[] {
  return [...clusters].sort((a, b) => {
    const aControl = isControlClusterType(a.clusterType);
    const bControl = isControlClusterType(b.clusterType);
    if (aControl !== bControl) return aControl ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
