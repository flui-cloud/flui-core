import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterRef } from '../../lib/resolve-cluster';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 1_200_000;

export default class ClusterRecoverAccess extends Command {
  static readonly description =
    'Get back into a node whose SSH is closed, through its provider rather than its network. ' +
    'OVH: the node is rebooted into a Debian rescue system, Flui’s host firewall is reset on its disk, ' +
    'and it is booted again with the firewall re-applied. Hetzner and Scaleway: port 22 is opened on the ' +
    'provider firewall to one address (yours by default) until you remove it. A machine you brought ' +
    'yourself is recovered from its own console.';

  static readonly summary = 'Emergency access to a node, through its provider';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> ovh-cluster master --yes',
    '<%= config.bin %> <%= command.id %> hz-cluster worker-1 --source-ip 203.0.113.7 --yes',
  ];

  static readonly args = {
    cluster: Args.string({ description: 'Cluster name or ID', required: true }),
    node: Args.string({
      description: 'Node server name or ID (default: the master)',
      required: false,
    }),
  };

  static readonly flags = {
    'source-ip': Flags.string({
      description:
        'Hetzner/Scaleway: the address to let in (default: the one the API sees you from)',
    }),
    yes: Flags.boolean({
      description: 'Proceed without asking',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClusterRecoverAccess);
    const storage = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: storage.getApiUrlOrThrow(),
      apiKey: storage.getApiKeyOrThrow(),
    });
    const { id: clusterId, name } = await resolveClusterRef(args.cluster);
    const cluster = await api.get<{
      nodes?: { id: string; serverName: string; nodeType: string }[];
    }>(`/infrastructure/clusters/${clusterId}`);
    const node = args.node
      ? cluster.nodes?.find(
          (n) =>
            n.serverName === args.node ||
            n.id === args.node ||
            n.serverName.endsWith(`-${args.node}`),
        )
      : cluster.nodes?.find((n) => n.nodeType === 'master');
    if (!node) this.error(`No node "${args.node ?? 'master'}" in ${name}.`);

    if (!flags.yes) {
      console.log(
        `\n  This goes around ${chalk.bold(node.serverName)}'s network, through its provider.`,
      );
      console.log(
        chalk.dim(
          '  On OVH the node reboots twice and is unavailable for several minutes.\n  Re-run with --yes to proceed.\n',
        ),
      );
      return;
    }

    const spinner = ora(`Recovering access to ${node.serverName}…`).start();
    let operationId: string;
    try {
      const res = await api.post<{ operation_id: string }>(
        `/infrastructure/clusters/${clusterId}/nodes/${node.id}/recover-access`,
        flags['source-ip'] ? { sourceIp: flags['source-ip'] } : {},
      );
      operationId = res.operation_id;
    } catch (error: any) {
      spinner.fail('Refused');
      console.log(
        chalk.red(`\n  ${error.response?.data?.message ?? error.message}\n`),
      );
      this.exit(1);
    }

    const started = Date.now();
    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const op = await api.get<{
        status: string;
        metadata?: { message?: string; outcome?: string; error?: string };
      }>(`/infrastructure/operations/${operationId}`);
      const status = op.status.toLowerCase();
      if (op.metadata?.message) spinner.text = op.metadata.message;
      if (status === 'completed') {
        spinner.succeed(op.metadata?.outcome ?? 'Access recovered');
        return;
      }
      if (status === 'failed') {
        spinner.fail('Not recovered');
        console.log(
          chalk.red(`\n  ${op.metadata?.error ?? 'Unknown error'}\n`),
        );
        this.exit(1);
      }
    }
    spinner.warn('Still running');
    console.log(
      chalk.dim(
        `\n  Check it with: flui env logs --operation ${operationId}\n`,
      ),
    );
  }
}
