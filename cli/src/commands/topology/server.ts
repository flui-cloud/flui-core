import { Args, Command, Flags } from '@oclif/core';
import {
  byServer,
  runTopology,
  topologyFlags,
} from '../../lib/topology/topology-command';

export default class TopologyServer extends Command {
  static readonly description =
    'One server: role, type, architecture, memory and CPU in use, its place on the Flui network, and the apps running on it.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> production-2',
    '<%= config.bin %> <%= command.id %> production-2 --system',
    '<%= config.bin %> <%= command.id %> production-2 --open',
  ];

  static readonly args = {
    server: Args.string({ description: 'Server name or id', required: true }),
  };

  static readonly flags = {
    ...topologyFlags,
    cluster: Flags.string({
      description: 'The cluster to look in, when the name is on several',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TopologyServer);
    await runTopology(this, flags, byServer(args.server, flags.cluster));
  }
}
