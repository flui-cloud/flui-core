import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { resizeNode } from '../../lib/node-resize';

export default class NodeResize extends Command {
  static readonly description =
    'Move a node of a workload cluster to another machine type: the node is\n' +
    'switched off for 3-5 minutes, its type changed by the provider, then it\n' +
    'comes back. On a cluster across three locations one node is resized at a\n' +
    'time, only while the rest is healthy, and a database primary on the node is\n' +
    'handed over first. For the control cluster use `flui env scale-node`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> workload-1-worker-2 --cluster workload-1 --type cx33',
    '<%= config.bin %> <%= command.id %> workload-1-worker-2 --cluster workload-1 --type cx43 --upgrade-disk --copies-gib 60',
  ];

  static readonly args = {
    node: Args.string({
      description: 'Node name or id (from `flui node list`)',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or id',
      required: true,
    }),
    type: Flags.string({
      char: 't',
      description:
        'Target machine type. Omitted: the next bigger type offered for this node',
    }),
    'upgrade-disk': Flags.boolean({
      description: '[Hetzner] Also grow the local disk (one-way)',
      default: false,
    }),
    'copies-gib': Flags.integer({
      description:
        'Grow the space this node sets aside for copies of replicated volumes to this many GiB once it is back',
      min: 1,
    }),
    confirm: Flags.boolean({
      description: 'Skip the typed confirmation prompt',
      default: false,
    }),
    wait: Flags.boolean({
      description:
        'Follow the resize until it ends (--no-wait returns once it is queued)',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(NodeResize);
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    try {
      const cluster = await resolveClusterRef(flags.cluster);
      const ok = await resizeNode(api, cluster.id, args.node, {
        type: flags.type,
        upgradeDisk: flags['upgrade-disk'],
        copiesGib: flags['copies-gib'],
        confirm: flags.confirm,
        wait: flags.wait,
      });
      if (!ok) this.exit(1);
      console.log('');
    } catch (error) {
      console.log(
        chalk.red(
          `\n❌ ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
      this.exit(1);
    }
  }
}
