import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import {
  EgressChange,
  EgressView,
  parseEgressPorts,
} from '../../lib/egress-view';

export default class ClusterEgress extends Command {
  static readonly description =
    'Show, limit or reopen the ports applications on a cluster may reach outside it. The rule applies to every application that is not part of the platform, whoever owns it, demo guests included; traffic inside the cluster is never restricted. Changing it needs the egress:manage permission.';

  static readonly summary = 'Outbound ports of the applications on a cluster';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-cluster',
    '<%= config.bin %> <%= command.id %> my-cluster --allow 80,443',
    '<%= config.bin %> <%= command.id %> my-cluster --allow 80,443,123/udp',
    '<%= config.bin %> <%= command.id %> my-cluster --open',
  ];

  static readonly args = {
    cluster: Args.string({ description: 'Cluster name or ID', required: true }),
  };

  static readonly flags = {
    allow: Flags.string({
      description:
        'Ports applications may reach outside the cluster, comma separated; TCP unless written as 123/udp. An empty value closes every port.',
      exclusive: ['open'],
    }),
    open: Flags.boolean({
      description:
        'Remove the rule: applications may reach the outside on any port',
      exclusive: ['allow'],
    }),
    json: Flags.boolean({ description: 'Print the rule as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClusterEgress);
    const storage = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: storage.getApiUrlOrThrow(),
      apiKey: storage.getApiKeyOrThrow(),
    });
    const { id: clusterId, name } = await resolveClusterRef(args.cluster);
    const path = `/infrastructure/clusters/${clusterId}/egress-policy`;

    let view: EgressView | EgressChange;
    try {
      if (flags.allow !== undefined) {
        view = await api.put<EgressChange>(path, {
          ports: parseEgressPorts(flags.allow),
        });
      } else if (flags.open) {
        view = await api.delete<EgressChange>(path);
      } else {
        view = await api.get<EgressView>(path);
      }
    } catch (error) {
      this.error((error as Error).message);
    }

    if (flags.json) {
      this.log(JSON.stringify(view, null, 2));
      return;
    }
    this.log(`\n  ${chalk.bold(name)}: ${view.summary}`);
    if ('applied' in view) {
      this.log(
        chalk.dim(`  Written into ${view.applied} application space(s)`),
      );
      for (const f of view.failed) {
        this.log(chalk.yellow(`  Not written in ${f.namespace}: ${f.error}`));
      }
    }
    this.log('');
    if ('failed' in view && view.failed.length > 0) this.exit(1);
  }
}
