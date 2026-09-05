import { Command, Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { confirmPrompt } from '../../lib/prompts';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 3_600_000;

interface PlanApp {
  applicationId: string;
  name: string;
  slug: string;
  status: string;
  blocked?: string;
  warnings: string[];
  restores: string[];
  phase?: string;
}

interface Plan {
  from: { id: string; name: string; status: string };
  to: { id: string; name: string; status: string };
  apps: PlanApp[];
  refusals: string[];
  warnings: string[];
  capacity?: {
    requiredCpuMillis: number;
    requiredMemoryMi: number;
    availableCpuMillis: number;
    availableMemoryMi: number;
    fits: boolean;
  };
}

interface ResultApp {
  applicationId: string;
  name: string;
  phase: string;
  error?: string;
  endpointMoved?: { from: string; to: string };
  notes?: string[];
}

export default class ClusterRebuild extends Command {
  static readonly description =
    'Re-materialise the applications of a lost cluster onto a live one, from the records and the backups.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> workload-cluster-3 --to workload-cluster-2 --plan',
    '<%= config.bin %> <%= command.id %> workload-cluster-3 --to workload-cluster-2',
    '<%= config.bin %> <%= command.id %> workload-cluster-3 --to workload-cluster-2 --include-stopped --yes',
  ];

  static readonly args = {
    cluster: Args.string({
      description: 'The lost cluster — name or ID',
      required: true,
    }),
  };

  static readonly flags = {
    to: Flags.string({
      description: 'The live cluster to rebuild onto',
      required: true,
    }),
    plan: Flags.boolean({
      description: 'Show what would happen and stop',
      default: false,
    }),
    'include-stopped': Flags.boolean({
      description:
        'Also rebuild applications that were not running when the cluster was lost',
      default: false,
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip the confirmation',
      default: false,
    }),
    'no-wait': Flags.boolean({
      description: 'Return once the rebuild is queued',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClusterRebuild);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }

    let from: { id: string; name: string };
    let to: { id: string; name: string };
    try {
      from = await resolveClusterRef(args.cluster);
      to = await resolveClusterRef(flags.to);
    } catch (error: any) {
      this.error(error.message, { exit: 1 });
    }

    const apiClient = new ApiClient({ baseUrl: apiUrl, apiKey });

    const spinner = ora('Reading the plan…').start();
    let plan: Plan;
    try {
      plan = await apiClient.get<Plan>(
        `/infrastructure/clusters/${from.id}/rebuild-plan?to=${to.id}`,
      );
      spinner.stop();
    } catch (error: any) {
      spinner.fail('Could not read the plan');
      this.error(error.response?.data?.message ?? error.message, { exit: 1 });
    }

    this.printPlan(plan, flags['include-stopped']);

    if (plan.refusals.length > 0) {
      console.log(chalk.red('\n  The rebuild cannot start:\n'));
      for (const r of plan.refusals) console.log(chalk.red(`    • ${r}`));
      console.log('');
      this.exit(1);
    }

    const willAttempt = plan.apps.filter(
      (a) => !a.blocked && (a.status === 'running' || flags['include-stopped']),
    );
    if (willAttempt.length === 0) {
      console.log(
        chalk.yellow('\n  Nothing to rebuild with the current flags.\n'),
      );
      return;
    }

    if (flags.plan) return;

    if (!flags.yes) {
      console.log('');
      const ok = await confirmPrompt(
        chalk.yellow(
          `  Rebuild ${willAttempt.length} application(s) onto ${to.name}?`,
        ),
        false,
      );
      if (!ok) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return;
      }
    }

    const queueSpinner = ora('Queuing the rebuild…').start();
    let operationId: string;
    try {
      const queued = await apiClient.post<{
        operation_id: string;
        applications: number;
      }>(`/infrastructure/clusters/${from.id}/rebuild`, {
        to: to.id,
        includeStopped: flags['include-stopped'],
      });
      operationId = queued.operation_id;
      queueSpinner.succeed(
        `Queued — ${queued.applications} application(s), operation ${operationId}`,
      );
    } catch (error: any) {
      queueSpinner.fail('Could not queue the rebuild');
      this.error(error.response?.data?.message ?? error.message, { exit: 1 });
    }

    if (flags['no-wait']) {
      console.log(
        chalk.dim(
          `\n  Follow it with \`flui cluster list\` or the dashboard.\n`,
        ),
      );
      return;
    }

    await this.follow(apiClient, operationId, to.name);
  }

  private printPlan(plan: Plan, includeStopped: boolean): void {
    console.log('');
    console.log(
      `  ${chalk.bold('Rebuild')} ${chalk.cyan(plan.from.name)} ${chalk.dim(`(${plan.from.status})`)} → ${chalk.cyan(plan.to.name)} ${chalk.dim(`(${plan.to.status})`)}`,
    );
    console.log('');

    if (plan.apps.length === 0) {
      console.log(chalk.dim('  No applications are recorded on this cluster.'));
      return;
    }

    for (const app of plan.apps) {
      const skipped =
        !app.blocked && app.status !== 'running' && !includeStopped;
      const mark = app.blocked
        ? chalk.red('✗')
        : skipped
          ? chalk.dim('–')
          : chalk.green('•');
      console.log(
        `  ${mark} ${chalk.bold(app.name)} ${chalk.dim(`(${app.status})`)}${app.phase ? chalk.dim(` — resumes at ${app.phase}`) : ''}`,
      );
      if (app.blocked) console.log(chalk.red(`      ${app.blocked}`));
      for (const r of app.restores ?? []) {
        console.log(chalk.green(`      ✓ ${r}`));
      }
      for (const w of app.warnings) console.log(chalk.yellow(`      ${w}`));
    }

    for (const w of plan.warnings ?? []) {
      console.log('');
      console.log(chalk.yellow(`  ⚠ ${w}`));
    }

    if (plan.capacity) {
      const c = plan.capacity;
      const line = `  Capacity: needs ${c.requiredCpuMillis}m CPU / ${c.requiredMemoryMi}Mi — destination has ${c.availableCpuMillis}m / ${c.availableMemoryMi}Mi`;
      console.log('');
      console.log(c.fits ? chalk.dim(line) : chalk.red(line));
    }
  }

  private async follow(
    apiClient: ApiClient,
    operationId: string,
    toName: string,
  ): Promise<void> {
    console.log('');
    const spinner = ora('Rebuilding…').start();
    const started = Date.now();
    const reported = new Set<string>();

    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      let op: {
        status: string;
        currentStepIndex: number;
        totalSteps: number;
        errorMessage?: string;
        metadata?: { apps?: ResultApp[] };
      };
      try {
        op = await apiClient.get(`/infrastructure/operations/${operationId}`);
      } catch {
        continue;
      }

      // Each application is printed once, as it lands, so a long rebuild reads
      // as progress rather than a spinner that might be stuck.
      for (const app of op.metadata?.apps ?? []) {
        if (reported.has(app.applicationId)) continue;
        reported.add(app.applicationId);
        spinner.stop();
        this.printApp(app);
        spinner.start();
      }
      spinner.text = `Rebuilding… ${op.currentStepIndex}/${op.totalSteps}`;

      if (op.status === 'COMPLETED') {
        spinner.stop();
        const failed = (op.metadata?.apps ?? []).filter(
          (a) => a.phase === 'failed',
        );
        console.log('');
        if (failed.length === 0) {
          console.log(
            chalk.green(`  Rebuilt onto ${toName}.`),
            chalk.dim('Re-run the command to continue anything skipped.'),
          );
        } else {
          console.log(
            chalk.yellow(
              `  ${failed.length} application(s) did not come back. Re-running continues each one from where it stopped.`,
            ),
          );
        }
        console.log('');
        return;
      }
      if (op.status === 'FAILED') {
        spinner.fail('The rebuild failed');
        console.log(chalk.red(`\n  ${op.errorMessage ?? 'Unknown error'}\n`));
        this.exit(1);
      }
    }

    spinner.warn('Still running — stopped waiting');
    console.log(chalk.dim(`  Operation ${operationId}\n`));
  }

  private printApp(app: ResultApp): void {
    const mark =
      app.phase === 'reconciled'
        ? chalk.green('✓')
        : app.phase === 'skipped'
          ? chalk.dim('–')
          : chalk.red('✗');
    console.log(`  ${mark} ${chalk.bold(app.name)} ${chalk.dim(app.phase)}`);
    if (app.error) console.log(chalk.dim(`      ${app.error}`));
    for (const note of app.notes ?? []) {
      console.log(chalk.yellow(`      ${note}`));
    }
    if (app.endpointMoved) {
      console.log(
        chalk.dim(
          `      ${app.endpointMoved.from} → ${chalk.cyan(app.endpointMoved.to)}`,
        ),
      );
    }
  }
}
