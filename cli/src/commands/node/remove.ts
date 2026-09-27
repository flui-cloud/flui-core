import { Command, Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliNodeService } from '../../lib/services/cli-node.service';
import { resolveCluster } from '../../lib/resolve-cluster';

const POLL_INTERVAL_MS = 4000;
const MAX_WAIT_MS = 300_000; // 5 min

export default class NodeRemove extends Command {
  static readonly description =
    'Detach a machine you attached yourself (`flui node connect`): cordon, drain and remove it from the cluster. Nodes Flui bought go back through the scaling group instead: `flui scaling floor <n>`. Cannot remove the master.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> <node-id>',
    '<%= config.bin %> <%= command.id %> <node-id> --no-wait',
  ];

  static readonly args = {
    nodeId: Args.string({
      description: 'Node ID to remove (from `flui node list`)',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    'no-wait': Flags.boolean({
      description: 'Return immediately after queuing the operation',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(NodeRemove);
    const spinner = ora(
      `Queuing remove-worker for node ${args.nodeId}...`,
    ).start();

    let service: CliNodeService;
    let clusterEntity: Awaited<ReturnType<typeof resolveCluster>>['entity'];
    try {
      const resolved = await resolveCluster(flags.cluster);
      clusterEntity = resolved.entity;
      service = await CliNodeService.create(resolved.id);
    } catch (error: any) {
      spinner.fail('Setup failed');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }

    // Pre-check: resolve node and guard against master removal
    let nodes: Awaited<ReturnType<CliNodeService['listNodes']>>;
    try {
      nodes = await service.listNodes();
    } catch (error: any) {
      spinner.fail('Failed to fetch node list');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }

    const target = nodes.find((n) => n.id === args.nodeId);
    if (!target) {
      spinner.fail('Node not found');
      console.log(
        chalk.red(`\n  Node "${args.nodeId}" not found in this cluster.\n`),
      );
      console.log(
        chalk.dim('  Run `flui node list` to see available node IDs.\n'),
      );
      this.exit(1);
    }

    if (target.nodeType === 'master') {
      this.refuseMasterRemoval(
        spinner,
        target,
        nodes,
        clusterEntity,
        flags.cluster,
      );
    }

    let result: Awaited<ReturnType<CliNodeService['removeWorker']>>;
    try {
      result = await service.removeWorker(args.nodeId);
    } catch (error: any) {
      spinner.fail('Failed to queue operation');
      const msg = error.response?.data?.message ?? error.message;
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }

    spinner.succeed('Remove operation queued');
    console.log('');
    console.log(`  ${chalk.bold('Operation ID:')} ${result.operation_id}`);
    console.log(
      `  ${chalk.bold('Estimated:')}    ${result.estimated_duration}`,
    );
    console.log('');

    if (flags['no-wait']) {
      console.log(
        chalk.dim('  Use `flui node list` to check when the node is gone.\n'),
      );
      return;
    }

    await this.waitForRemoval(service, result.operation_id);
  }

  private refuseMasterRemoval(
    spinner: ReturnType<typeof ora>,
    target: { serverName: string },
    nodes: Array<{ id: string; nodeType: string; serverName: string }>,
    clusterEntity: {
      name: string;
      metadata?: { isObservabilityCluster?: boolean };
    },
    clusterFlag?: string,
  ): never {
    spinner.fail('Cannot remove the master node');
    const workers = nodes.filter((n) => n.nodeType === 'worker');
    const isObservability =
      clusterEntity.metadata?.isObservabilityCluster === true;
    console.log('');
    console.log(
      chalk.yellow(
        `  "${target.serverName}" is the master node of cluster "${clusterEntity.name}".`,
      ),
    );
    if (workers.length > 0) {
      console.log(
        chalk.yellow(
          `  There ${workers.length === 1 ? 'is' : 'are'} still ${workers.length} worker node(s) running.`,
        ),
      );
      console.log('');
      console.log(chalk.dim('  To scale down, remove the workers first:'));
      const clusterSuffix = clusterFlag ? ` --cluster ${clusterFlag}` : '';
      for (const w of workers) {
        console.log(chalk.dim(`    flui node remove ${w.id}${clusterSuffix}`));
      }
    }
    console.log('');
    console.log(
      chalk.dim('  To destroy the entire cluster (master + all workers):'),
    );
    console.log(
      isObservability
        ? chalk.cyan('    flui env destroy')
        : chalk.cyan(`    flui cluster destroy ${clusterEntity.name}`),
    );
    console.log('');
    this.exit(1);
  }

  private async waitForRemoval(
    service: CliNodeService,
    operationId: string,
  ): Promise<void> {
    console.log(
      chalk.dim(
        `  Draining and deleting node… (up to ${MAX_WAIT_MS / 60000} min)`,
      ),
    );
    console.log('');

    const waitSpinner = ora('Draining node…').start();
    const started = Date.now();

    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const done = await this.pollNodeRemoval(
        service,
        operationId,
        waitSpinner,
      );
      if (done) return;
    }

    waitSpinner.warn('Timed out waiting for operation');
    console.log(chalk.yellow(`\n  Operation ${operationId} is still running.`));
    console.log(
      chalk.dim('  Run `flui node list` to check status when it completes.\n'),
    );
  }

  private async pollNodeRemoval(
    service: CliNodeService,
    operationId: string,
    waitSpinner: ReturnType<typeof ora>,
  ): Promise<boolean> {
    try {
      const op = await service.getOperationStatus(operationId);
      const pct =
        op.totalSteps > 0
          ? Math.round((op.currentStepIndex / op.totalSteps) * 100)
          : 0;
      waitSpinner.text = `Draining and deleting… ${pct}% (step ${op.currentStepIndex}/${op.totalSteps})`;

      if (op.status === 'COMPLETED') {
        const warned = op.metadata?.warnings?.some(
          (w: any) => w.code === 'DRAIN_FAILED',
        );
        if (warned) {
          waitSpinner.warn(
            chalk.yellow(
              'Node removed (drain failed — PDB may have blocked eviction)',
            ),
          );
        } else {
          waitSpinner.succeed(chalk.green('Node removed successfully'));
        }
        console.log('');
        console.log(
          chalk.dim('  Run `flui node list` to see the updated node list.\n'),
        );
        return true;
      }
      if (op.status === 'FAILED') {
        waitSpinner.fail('Operation failed');
        const errorMsg = op.metadata?.error ?? 'Unknown error';
        console.log(chalk.red(`\n  Error: ${errorMsg}\n`));
        this.exit(1);
      }
    } catch {
      /* polling error — keep trying */
    }
    return false;
  }
}
