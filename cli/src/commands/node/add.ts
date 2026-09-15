import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliNodeService } from '../../lib/services/cli-node.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 600_000; // 10 min

export default class NodeAdd extends Command {
  static readonly description =
    'Add worker node(s) to the cluster. Provisions new servers and joins them to K3s.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --count 2',
    '<%= config.bin %> <%= command.id %> --count 3 --no-wait',
  ];

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    count: Flags.integer({
      char: 'n',
      description: 'Number of workers to add (1-5)',
      default: 1,
      min: 1,
      max: 5,
    }),
    'no-wait': Flags.boolean({
      description: 'Return immediately after queuing the operation',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(NodeAdd);
    const spinner = ora(
      `Queuing add-worker operation (count=${flags.count})...`,
    ).start();

    let service: CliNodeService;
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      service = await CliNodeService.create(clusterId);
    } catch (error: any) {
      spinner.fail('Setup failed');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }

    let result: Awaited<ReturnType<CliNodeService['addWorkers']>>;
    try {
      result = await service.addWorkers(flags.count);
    } catch (error: any) {
      spinner.fail('Failed to queue operation');
      const msg = error.response?.data?.message ?? error.message;
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }

    spinner.succeed(`Operation queued`);
    console.log('');
    console.log(`  ${chalk.bold('Operation ID:')} ${result.operation_id}`);
    console.log(
      `  ${chalk.bold('Estimated:')}    ${result.estimated_duration}`,
    );
    console.log('');

    if (flags['no-wait']) {
      console.log(
        chalk.dim('  Use `flui node list` to check when nodes are ready.\n'),
      );
      return;
    }

    console.log(
      chalk.dim(
        `  Waiting for operation to complete (up to ${MAX_WAIT_MS / 60000} min)…`,
      ),
    );
    console.log('');

    const waitSpinner = ora('Provisioning workers…').start();
    const started = Date.now();

    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      try {
        const op = await service.getOperationStatus(result.operation_id);
        const pct =
          op.totalSteps > 0
            ? Math.round((op.currentStepIndex / op.totalSteps) * 100)
            : 0;
        waitSpinner.text = `Provisioning workers… ${pct}% (step ${op.currentStepIndex}/${op.totalSteps})`;

        if (op.status === 'COMPLETED') {
          waitSpinner.succeed(chalk.green(`Workers added successfully`));
          console.log('');
          console.log(
            chalk.dim('  Run `flui node list` to see the updated node list.\n'),
          );
          return;
        }

        if (op.status === 'FAILED') {
          waitSpinner.fail('Operation failed');
          const errorMsg = op.metadata?.error ?? 'Unknown error';
          console.log(chalk.red(`\n  Error: ${errorMsg}\n`));
          this.exit(1);
        }
      } catch {
        // polling error — keep trying
      }
    }

    waitSpinner.warn('Timed out waiting for operation');
    console.log(
      chalk.yellow(`\n  Operation ${result.operation_id} is still running.`),
    );
    console.log(
      chalk.dim('  Run `flui node list` to check status when it completes.\n'),
    );
  }
}
