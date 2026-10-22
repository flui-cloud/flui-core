import { Args, Command, Flags } from '@oclif/core';
import {
  byApp,
  runTopology,
  topologyFlags,
} from '../../lib/topology/topology-command';

export default class TopologyApp extends Command {
  static readonly description =
    'One app: status, replicas, exposure and traffic, who calls it and what it talks to, and the servers its replicas run on.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> storefront',
    '<%= config.bin %> <%= command.id %> api --cluster staging',
    '<%= config.bin %> <%= command.id %> storefront --watch',
    '<%= config.bin %> <%= command.id %> storefront --open',
  ];

  static readonly args = {
    app: Args.string({ description: 'App name or id', required: true }),
  };

  static readonly flags = {
    ...topologyFlags,
    cluster: Flags.string({
      description: 'The cluster to look in, when the name is on several',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TopologyApp);
    await runTopology(this, flags, byApp(args.app, flags.cluster));
  }
}
