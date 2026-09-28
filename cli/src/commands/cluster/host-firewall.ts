import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient, ApiError } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterRef } from '../../lib/resolve-cluster';

interface HostLayer {
  applicable: boolean;
  enabled: boolean;
  state: string;
  reason: string | null;
  appliedAt: string | null;
  appliedNodes: number | null;
  lastAttemptAt: string | null;
}

interface FirewallResponse {
  hostLayer?: HostLayer;
}

const STATE_LABEL: Record<string, (s: string) => string> = {
  applied: chalk.green,
  pending: chalk.yellow,
  blocked: chalk.yellow,
  failed: chalk.red,
  removing: chalk.yellow,
  off: chalk.dim,
  'not-applicable': chalk.dim,
};

export default class ClusterHostFirewall extends Command {
  static readonly description =
    "Show, or turn on or off, the host firewall of a workload cluster. On Hetzner and Scaleway the provider's firewall filters in front of the nodes; the host firewall adds the same rules on each node, so a node left outside the provider firewall still exposes only SSH, HTTP, HTTPS and the Flui network. It is on for clusters created from now on; existing clusters stay off until you turn it on.";

  static readonly summary = 'Host firewall of a workload cluster';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-cluster',
    '<%= config.bin %> <%= command.id %> my-cluster --on',
    '<%= config.bin %> <%= command.id %> my-cluster --off',
  ];

  static readonly args = {
    cluster: Args.string({ description: 'Cluster name or ID', required: true }),
  };

  static readonly flags = {
    on: Flags.boolean({
      description: 'Turn the host firewall on and apply it now',
      exclusive: ['off'],
    }),
    off: Flags.boolean({
      description: 'Turn the host firewall off and remove it from the nodes',
      exclusive: ['on'],
    }),
    json: Flags.boolean({ description: 'Print the state as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClusterHostFirewall);
    const storage = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: storage.getApiUrlOrThrow(),
      apiKey: storage.getApiKeyOrThrow(),
    });
    const { id: clusterId, name } = await resolveClusterRef(args.cluster);

    let firewall: FirewallResponse;
    try {
      firewall =
        flags.on || flags.off
          ? await api.post<FirewallResponse>(
              `/firewalls/cluster/${clusterId}/host-layer`,
              { enabled: !!flags.on },
            )
          : await api.get<FirewallResponse>(`/firewalls/cluster/${clusterId}`);
    } catch (error) {
      const status = error instanceof ApiError ? error.statusCode : undefined;
      if (status === 404) {
        this.error(
          `${name} has no cluster firewall yet. Apply one first with the dashboard or the API.`,
        );
      }
      this.error((error as Error).message);
    }

    const layer = firewall.hostLayer;
    if (flags.json) {
      this.log(JSON.stringify(layer ?? null, null, 2));
      return;
    }
    if (!layer?.applicable) {
      this.log(
        `\n  ${name}: the host firewall is not offered here — on this cluster the cluster firewall already runs on the nodes, or it is the control cluster.\n`,
      );
      return;
    }

    const paint = STATE_LABEL[layer.state] ?? ((s: string) => s);
    this.log(`\n  ${chalk.bold(name)} host firewall: ${paint(layer.state)}`);
    if (layer.appliedAt) {
      const nodes = layer.appliedNodes
        ? ` on ${layer.appliedNodes} node(s)`
        : '';
      this.log(chalk.dim(`  Applied ${layer.appliedAt}${nodes}`));
    }
    if (layer.reason) this.log(chalk.yellow(`  ${layer.reason}`));
    if (!layer.enabled) {
      const command = chalk.cyan(`flui cluster host-firewall ${name} --on`);
      this.log(chalk.dim(`  Turn it on with: ${command}`));
    }
    this.log('');
    if (layer.state === 'failed') this.exit(1);
  }
}
