import { Args, Command } from '@oclif/core';
import {
  byCluster,
  runTopology,
  topologyFlags,
} from '../../lib/topology/topology-command';

export default class TopologyCluster extends Command {
  static readonly description =
    'One cluster: its apps by project with replicas, status and requests per second, the Flui platform, and its servers.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> production',
    '<%= config.bin %> <%= command.id %> production --system',
    '<%= config.bin %> <%= command.id %> production --watch',
    '<%= config.bin %> <%= command.id %> production --open',
  ];

  static readonly args = {
    cluster: Args.string({ description: 'Cluster name or id', required: true }),
  };

  static readonly flags = topologyFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TopologyCluster);
    await runTopology(this, flags, byCluster(args.cluster));
  }
}
