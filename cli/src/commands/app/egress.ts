import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { resolveApp } from '../../lib/resolve-app';
import { EgressView } from '../../lib/egress-view';

export default class AppEgress extends Command {
  static readonly description =
    'Show which ports an application may reach outside its cluster. An administrator sets this for the whole cluster; ask them to open another port.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --json',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or ID',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    json: Flags.boolean({ description: 'Print the rule as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppEgress);
    const storage = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: storage.getApiUrlOrThrow(),
      apiKey: storage.getApiKeyOrThrow(),
    });
    const { id: clusterId } = await resolveClusterRef(flags.cluster);
    const app = await resolveApp(clusterId, args.name);

    let view: EgressView;
    try {
      view = await api.get<EgressView>(`/applications/${app.id}/egress`);
    } catch (error) {
      this.error((error as Error).message);
    }

    if (flags.json) {
      this.log(JSON.stringify(view, null, 2));
      return;
    }
    this.log(`\n  ${chalk.bold(app.name)}: ${view.summary}\n`);
  }
}
