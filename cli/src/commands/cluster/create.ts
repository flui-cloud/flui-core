import { Command, Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { listClusters } from '../../lib/cluster-listing';
import { getRecommendedServerType } from '../../config/defaults';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 1_800_000; // 30 min — matches the server-side estimate for master + N workers

export default class ClusterCreate extends Command {
  static readonly description =
    'Create a workload cluster. Runs on the same provider as the control ' +
    'cluster (a hard constraint — the dashboard enforces the same rule) and ' +
    'attaches to its environment VNet automatically when the provider needs one.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-workload',
    '<%= config.bin %> <%= command.id %> my-workload --node-size d2-4 --worker-count 2',
    '<%= config.bin %> <%= command.id %> my-workload --no-wait',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Cluster name (must be unique)',
      required: true,
    }),
  };

  static readonly flags = {
    'node-size': Flags.string({
      description:
        'Server type for cluster nodes. Defaults to the provider recommended size.',
    }),
    region: Flags.string({
      description:
        "Region/location code. Defaults to the control cluster's own region.",
    }),
    'worker-count': Flags.integer({
      description: 'Number of worker nodes (0 = master-only)',
      default: 0,
    }),
    'no-wait': Flags.boolean({
      description: 'Return immediately after queuing creation',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClusterCreate);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const apiClient = new ApiClient({ baseUrl: apiUrl, apiKey });

    // Workload clusters must share the control cluster's provider — find it
    // rather than asking the caller to know and repeat it correctly.
    const { clusters, apiError } = await listClusters();
    if (apiError) {
      this.error(
        `Could not reach the API to find the control cluster: ${apiError}`,
        {
          exit: 1,
        },
      );
    }
    const control = clusters.find((c) =>
      ['control', 'observability'].includes(
        String(c.clusterType).toLowerCase(),
      ),
    );
    if (!control?.provider) {
      this.error(
        'No control cluster found — a workload cluster needs one to attach to.',
        { exit: 1 },
      );
    }

    const provider = control.provider;
    const region = flags.region ?? control.region ?? '';
    const nodeSize = flags['node-size'] ?? getRecommendedServerType(provider);

    const spinner = ora(
      `Checking "${args.name}" is free on ${provider}...`,
    ).start();
    try {
      const availability = await apiClient.get<{
        available: boolean;
        reason?: string;
      }>(
        `/infrastructure/clusters/name-availability?name=${encodeURIComponent(args.name)}&provider=${encodeURIComponent(provider)}`,
      );
      if (!availability.available) {
        spinner.fail(availability.reason ?? 'Name not available');
        this.exit(1);
      }
      spinner.succeed('Name available');
    } catch (error: any) {
      // Best-effort — the create call re-validates server-side regardless.
      spinner.warn(
        `Could not pre-check name availability: ${error.message} — continuing`,
      );
    }

    console.log('');
    console.log(`  ${chalk.bold('Name:')}         ${args.name}`);
    console.log(`  ${chalk.bold('Provider:')}     ${provider}`);
    console.log(
      `  ${chalk.bold('Region:')}       ${region || '(provider default)'}`,
    );
    console.log(`  ${chalk.bold('Node size:')}    ${nodeSize}`);
    console.log(`  ${chalk.bold('Worker nodes:')} ${flags['worker-count']}`);
    console.log('');

    const createSpinner = ora('Queuing cluster creation...').start();
    let operationId: string;
    let clusterId: string;
    try {
      const result = await apiClient.post<{
        operation_id: string;
        resource_id: string;
        cluster_id: string;
        status: string;
        estimated_duration: string;
      }>('/infrastructure/clusters', {
        name: args.name,
        provider,
        region,
        nodeSize,
        workerCount: flags['worker-count'],
      });
      operationId = result.operation_id;
      clusterId = result.cluster_id;
      createSpinner.succeed('Creation queued');
      console.log('');
      console.log(`  ${chalk.bold('Cluster ID:')}   ${clusterId}`);
      console.log(`  ${chalk.bold('Operation ID:')} ${operationId}`);
      console.log(
        `  ${chalk.bold('Estimated:')}    ${result.estimated_duration}`,
      );
      console.log('');
    } catch (error: any) {
      createSpinner.fail('Failed to queue creation');
      const msg = error.response?.data?.message ?? error.message;
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }

    if (flags['no-wait']) {
      console.log(
        chalk.dim(
          `  Use \`flui env logs\` or \`flui cluster list\` to check status.\n`,
        ),
      );
      return;
    }

    await this.waitForCreation(apiClient, operationId, args.name);
  }

  private async waitForCreation(
    apiClient: ApiClient,
    operationId: string,
    clusterName: string,
  ): Promise<void> {
    console.log(
      chalk.dim(
        `  Waiting for creation to complete (up to ${MAX_WAIT_MS / 60000} min)…`,
      ),
    );
    const waitSpinner = ora('Creating cluster…').start();
    const started = Date.now();

    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const result = await this.pollOperation(
        apiClient,
        operationId,
        clusterName,
        waitSpinner,
      );
      if (result === 'failed') this.exit(1);
      if (result === 'completed') return;
    }

    waitSpinner.warn('Timed out waiting for creation');
    console.log(
      chalk.yellow(`\n  Operation is still running. Check status with:`),
    );
    console.log(chalk.dim(`    flui env logs --operation ${operationId}\n`));
  }

  private async pollOperation(
    apiClient: ApiClient,
    operationId: string,
    clusterName: string,
    waitSpinner: ReturnType<typeof ora>,
  ): Promise<'completed' | 'failed' | 'pending'> {
    try {
      const op = await apiClient.get<{
        status: string;
        currentStepIndex: number;
        totalSteps: number;
        metadata?: any;
      }>(`/infrastructure/operations/${operationId}`);
      const pct =
        op.totalSteps > 0
          ? Math.round((op.currentStepIndex / op.totalSteps) * 100)
          : 0;
      waitSpinner.text = `Creating cluster… ${pct}% (step ${op.currentStepIndex}/${op.totalSteps})`;

      if (op.status === 'COMPLETED') {
        waitSpinner.succeed(chalk.green(`Cluster "${clusterName}" created`));
        return 'completed';
      }
      // Exiting here would throw oclif's ExitError into the catch below, which
      // swallows it as a polling failure and keeps retrying until the timeout.
      if (op.status === 'FAILED') {
        waitSpinner.fail('Creation failed');
        const msg = op.metadata?.error ?? 'Unknown error';
        console.log(chalk.red(`\n  Error: ${msg}\n`));
        return 'failed';
      }
    } catch {
      /* polling error — keep trying */
    }
    return 'pending';
  }
}
