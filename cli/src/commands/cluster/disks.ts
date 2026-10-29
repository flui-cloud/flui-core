import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterRef } from '../../lib/resolve-cluster';

interface DiskSpace {
  totalGiB: number;
  freeGiB: number;
}

interface NodeDisksView {
  measuredAt: string;
  nodes: Array<{
    node: string;
    zone: string | null;
    disk: DiskSpace | null;
    copies: DiskSpace | null;
  }>;
  warnings: string[];
}

const space = (s: DiskSpace | null) =>
  s ? `${s.freeGiB} of ${s.totalGiB} GiB free` : chalk.dim('—');

export default class ClusterDisks extends Command {
  static readonly description =
    'How much room is left on each node: its own disk, where databases and\n' +
    'data kept on the node live, and the space set aside for copies of\n' +
    'replicated volumes. Names a node running short.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> workload-cluster-1',
  ];

  static readonly args = {
    cluster: Args.string({ description: 'Cluster name or id', required: true }),
  };

  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClusterDisks);
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    const cluster = await resolveClusterRef(args.cluster);
    const view = await api.get<NodeDisksView>(
      `/infrastructure/clusters/${cluster.id}/storage/disks`,
    );
    if (flags.json) {
      this.log(JSON.stringify(view, null, 2));
      return;
    }
    this.log('');
    this.log(`   ${chalk.bold(args.cluster)}`);
    this.log('');
    this.log(
      `   ${'NODE'.padEnd(28)} ${'LOCATION'.padEnd(10)} ${'DISK'.padEnd(24)} COPIES`,
    );
    for (const n of view.nodes) {
      this.log(
        `   ${n.node.padEnd(28)} ${(n.zone ?? '—').padEnd(10)} ${space(n.disk).padEnd(24)} ${space(n.copies)}`,
      );
    }
    if (view.warnings.length) {
      this.log('');
      for (const w of view.warnings) this.log(`   ${chalk.yellow(w)}`);
    }
    this.log('');
  }
}
