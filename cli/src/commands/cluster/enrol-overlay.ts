import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterRef } from '../../lib/resolve-cluster';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 600_000;

/**
 * For clusters that predate the management tunnel.
 *
 * A cluster installed before it existed has no management address in its API
 * server certificate, so the control cluster can reach it through the tunnel
 * and still be refused at the TLS handshake. Clusters created since carry the
 * address from their first boot and need none of this.
 */
export default class ClusterEnrolOverlay extends Command {
  static readonly description =
    'Bring an existing cluster onto the private management tunnel. Restarts ' +
    'Kubernetes on the cluster’s first node to reissue its certificate, and ' +
    'puts the node back exactly as it was if it does not come up.';

  static readonly summary = 'Enrol an existing cluster onto the tunnel';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --cluster workload-1',
  ];

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one exists)',
    }),
    yes: Flags.boolean({
      description: 'Skip the confirmation',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ClusterEnrolOverlay);

    const configStorage = new ConfigStorage();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const apiClient = new ApiClient({
      baseUrl: configStorage.getApiUrlOrThrow(),
      apiKey,
    });

    const { id: clusterId, name } = await resolveClusterRef(flags.cluster);

    if (!flags.yes) {
      console.log('');
      console.log(
        `  This restarts Kubernetes on ${chalk.bold(name)}'s first node.`,
      );
      console.log(
        chalk.dim(
          '  Applications keep running. The cluster is unmanageable for about\n' +
            '  a minute, and is put back as it was if it does not come up.\n' +
            '  Re-run with --yes to proceed.',
        ),
      );
      console.log('');
      return;
    }

    const spinner = ora(`Enrolling ${name}…`).start();
    let operationId: string;
    let address: string | undefined;
    try {
      const res = await apiClient.post<{
        operation_id: string;
        management_address?: string;
      }>(`/infrastructure/clusters/${clusterId}/overlay-enrolment`, {});
      operationId = res.operation_id;
      address = res.management_address;
      spinner.succeed(`Queued (address ${address ?? 'unknown'})`);
    } catch (error: any) {
      spinner.fail('Refused');
      console.log(
        chalk.red(`\n  ${error.response?.data?.message ?? error.message}\n`),
      );
      this.exit(1);
    }

    const waitSpinner = ora('Reissuing the certificate…').start();
    const started = Date.now();
    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const op = await apiClient.get<{
        status: string;
        metadata?: {
          outcome?: string;
          certificateIps?: string[];
          error?: string;
        };
      }>(`/infrastructure/operations/${operationId}`);

      if (op.status === 'completed') {
        waitSpinner.succeed(
          op.metadata?.outcome === 'already-present'
            ? `${name} was already on the tunnel`
            : `${name} is on the tunnel`,
        );
        const ips = op.metadata?.certificateIps ?? [];
        if (ips.length) {
          console.log(
            chalk.dim(`\n  Certificate now covers: ${ips.join(', ')}\n`),
          );
        }
        return;
      }
      if (op.status === 'failed') {
        waitSpinner.fail('Not enrolled');
        console.log(
          chalk.red(`\n  ${op.metadata?.error ?? 'Unknown error'}\n`),
        );
        this.exit(1);
      }
    }

    waitSpinner.warn('Still running');
    console.log(
      chalk.dim(
        `\n  Check it with: flui env logs --operation ${operationId}\n`,
      ),
    );
  }
}
