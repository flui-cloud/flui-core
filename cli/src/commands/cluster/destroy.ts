import { Command, Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { listClusters } from '../../lib/cluster-listing';
import { confirmByTypingPrompt } from '../../lib/prompts';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 600_000;

export default class ClusterDestroy extends Command {
  static readonly description =
    'Permanently destroy a workload cluster and all its nodes. For the control cluster use `flui env destroy`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-workload-cluster',
    '<%= config.bin %> <%= command.id %> my-workload-cluster --force',
    '<%= config.bin %> <%= command.id %> my-workload-cluster --no-wait',
  ];

  static readonly args = {
    cluster: Args.string({
      description: 'Cluster name or ID to destroy',
      required: true,
    }),
  };

  static readonly flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    }),
    'no-wait': Flags.boolean({
      description: 'Return immediately after queuing deletion',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClusterDestroy);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();

    // resolveCluster()/resolveClusterRef() only search the local store, which
    // never holds workload clusters (they live in the control cluster's own
    // database) — listing straight from the API is the only way this command
    // can ever find the cluster it's meant to destroy.
    const { clusters, apiError } = await listClusters();
    if (apiError) {
      this.error(`Could not reach the API to find the cluster: ${apiError}`, {
        exit: 1,
      });
    }
    const needle = args.cluster.toLowerCase();
    const match = clusters.find(
      (c) => c.id === args.cluster || c.name.toLowerCase() === needle,
    );
    if (!match) {
      this.error(
        `Cluster "${args.cluster}" not found. Available clusters:\n` +
          clusters.map((c) => `  • ${c.name}  (${c.id})`).join('\n'),
        { exit: 1 },
      );
    }

    const clusterId = match.id;
    const clusterName = match.name;

    if (
      (match.metadata as { isObservabilityCluster?: boolean })
        ?.isObservabilityCluster
    ) {
      this.error(
        `"${clusterName}" is the control cluster. Use \`flui env destroy\` instead.`,
        { exit: 1 },
      );
    }

    console.log(chalk.red('\n⚠️  DESTROY Workload Cluster\n'));
    console.log(`  ${chalk.bold('Name:')}    ${clusterName}`);
    console.log(`  ${chalk.bold('ID:')}      ${clusterId}`);
    console.log(`  ${chalk.bold('Status:')}  ${match.status}`);
    console.log(`  ${chalk.bold('Region:')}  ${match.region}`);
    console.log(`  ${chalk.bold('Nodes:')}   ${match.nodeCount}`);
    console.log(chalk.red('\n  ⚠️  ALL DATA WILL BE PERMANENTLY LOST!\n'));

    if (!flags.force) {
      console.log(
        chalk.yellow(
          `  To confirm, type the cluster name exactly: ${chalk.bold(clusterName)}`,
        ),
      );
      const confirmed = await confirmByTypingPrompt(
        chalk.yellow('  Cluster name'),
        clusterName,
      );
      if (!confirmed) {
        console.log(
          chalk.green('\n  Deletion cancelled (name did not match)\n'),
        );
        return;
      }
    }

    const spinner = ora('Queuing cluster deletion...').start();
    const apiClient = new ApiClient({ baseUrl: apiUrl, apiKey: apiKey });

    let operationId: string;
    try {
      const result = await apiClient.delete<{
        operation_id: string;
        status: string;
        estimated_duration: string;
        // `force` on the API means "delete it even though the server is
        // running" — which is every cluster this command is pointed at. The
        // gate is the typed cluster name above, not this flag.
      }>(`/infrastructure/clusters/${clusterId}?force=true`);
      operationId = result.operation_id;
      spinner.succeed('Deletion queued');
      console.log('');
      console.log(`  ${chalk.bold('Operation ID:')} ${operationId}`);
      console.log(
        `  ${chalk.bold('Estimated:')}    ${result.estimated_duration}`,
      );
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to queue deletion');
      const msg = error.response?.data?.message ?? error.message;
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }

    if (flags['no-wait']) {
      console.log(
        chalk.dim('  Use `flui node list --cluster <name>` to check status.\n'),
      );
      return;
    }

    await this.waitForDeletion(apiClient, operationId, clusterName);
  }

  private async waitForDeletion(
    apiClient: ApiClient,
    operationId: string,
    clusterName: string,
  ): Promise<void> {
    console.log(
      chalk.dim(
        `  Waiting for deletion to complete (up to ${MAX_WAIT_MS / 60000} min)…`,
      ),
    );
    const waitSpinner = ora('Deleting cluster…').start();
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

    waitSpinner.warn('Timed out waiting for deletion');
    console.log(
      chalk.yellow(`\n  Operation is still running. Check status with:`),
    );
    console.log(chalk.dim(`    flui node list --cluster ${clusterName}\n`));
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
      waitSpinner.text = `Deleting cluster… ${pct}% (step ${op.currentStepIndex}/${op.totalSteps})`;

      if (op.status === 'COMPLETED') {
        waitSpinner.succeed(chalk.green(`Cluster "${clusterName}" destroyed`));
        console.log('');
        console.log(
          chalk.dim(
            '  All nodes and associated resources have been removed.\n',
          ),
        );
        return 'completed';
      }
      // Exiting here would throw oclif's ExitError into the catch below, which
      // swallows it as a polling failure and keeps retrying until the timeout.
      if (op.status === 'FAILED') {
        waitSpinner.fail('Deletion failed');
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
