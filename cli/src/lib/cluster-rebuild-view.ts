import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from './api-client';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 3_600_000;

export interface RebuildPlanApp {
  applicationId: string;
  name: string;
  slug: string;
  status: string;
  blocked?: string;
  warnings: string[];
  restores: string[];
  phase?: string;
  after?: string[];
}

export interface RebuildPlan {
  mode?: 'workload' | 'control';
  from: { id: string; name: string; status: string };
  to: { id: string; name: string; status: string };
  apps: RebuildPlanApp[];
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
  endpointMoved?: { from: string; to: string }[];
  notes?: string[];
}

/** The applications a run will attempt with these flags. */
export function appsToAttempt(
  plan: RebuildPlan,
  includeStopped: boolean,
): RebuildPlanApp[] {
  return plan.apps.filter(
    (a) => !a.blocked && (a.status === 'running' || includeStopped),
  );
}

export function printRebuildPlan(
  plan: RebuildPlan,
  includeStopped: boolean,
  verb = 'Rebuild',
): void {
  const from = `${chalk.cyan(plan.from.name)} ${dimParens(plan.from.status)}`;
  const to = `${chalk.cyan(plan.to.name)} ${dimParens(plan.to.status)}`;
  console.log('');
  console.log(`  ${chalk.bold(verb)} ${from} → ${to}`);
  console.log('');

  if (plan.apps.length === 0) {
    console.log(chalk.dim('  No applications are recorded on this cluster.'));
  }

  for (const app of plan.apps) printPlanApp(app, includeStopped);

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

function dimParens(text: string): string {
  return chalk.dim('(' + text + ')');
}

function planMark(app: RebuildPlanApp, includeStopped: boolean): string {
  if (app.blocked) return chalk.red('✗');
  if (app.status !== 'running' && !includeStopped) return chalk.dim('–');
  return chalk.green('•');
}

function printPlanApp(app: RebuildPlanApp, includeStopped: boolean): void {
  const resumes = app.phase ? chalk.dim(' — resumes at ' + app.phase) : '';
  console.log(
    `  ${planMark(app, includeStopped)} ${chalk.bold(app.name)} ${dimParens(app.status)}${resumes}`,
  );
  if (app.after?.length) {
    console.log(chalk.dim(`      after ${app.after.join(', ')}`));
  }
  if (app.blocked) console.log(chalk.red(`      ${app.blocked}`));
  for (const r of app.restores ?? []) {
    console.log(chalk.green(`      ✓ ${r}`));
  }
  for (const w of app.warnings) console.log(chalk.yellow(`      ${w}`));
}

/**
 * Follows the operation, printing each application once as it lands so a long
 * rebuild reads as progress rather than a spinner that might be stuck.
 * Resolves to false when the operation itself failed.
 */
export async function followRebuild(
  apiClient: ApiClient,
  operationId: string,
  toName: string,
  rerun: string,
): Promise<boolean> {
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

    const apps = op.metadata?.apps ?? [];
    const fresh = unreported(apps, reported);
    if (fresh.length > 0) {
      spinner.stop();
      fresh.forEach(printResultApp);
      spinner.start();
    }
    spinner.text = `Rebuilding… ${op.currentStepIndex}/${op.totalSteps}`;

    if (op.status === 'COMPLETED') {
      spinner.stop();
      printCompletion(apps, toName, rerun);
      return true;
    }
    if (op.status === 'FAILED') {
      spinner.fail('The rebuild failed');
      console.log(chalk.red(`\n  ${op.errorMessage ?? 'Unknown error'}\n`));
      return false;
    }
  }

  spinner.warn('Still running — stopped waiting');
  console.log(chalk.dim(`  Operation ${operationId}\n`));
  return true;
}

function unreported(apps: ResultApp[], reported: Set<string>): ResultApp[] {
  const fresh: ResultApp[] = [];
  for (const app of apps) {
    if (reported.has(app.applicationId)) continue;
    reported.add(app.applicationId);
    fresh.push(app);
  }
  return fresh;
}

function printCompletion(
  apps: ResultApp[],
  toName: string,
  rerun: string,
): void {
  const failed = apps.filter((a) => a.phase === 'failed');
  console.log('');
  if (failed.length === 0) {
    console.log(
      chalk.green(`  Rebuilt onto ${toName}.`),
      chalk.dim(`Re-run \`${rerun}\` to continue anything skipped.`),
    );
  } else {
    console.log(
      chalk.yellow(
        `  ${failed.length} application(s) did not come back. Re-running \`${rerun}\` continues each one from where it stopped.`,
      ),
    );
  }
  console.log('');
}

function resultMark(phase: string): string {
  if (phase === 'reconciled') return chalk.green('✓');
  if (phase === 'skipped') return chalk.dim('–');
  return chalk.red('✗');
}

function printResultApp(app: ResultApp): void {
  console.log(
    `  ${resultMark(app.phase)} ${chalk.bold(app.name)} ${chalk.dim(app.phase)}`,
  );
  if (app.error) console.log(chalk.dim(`      ${app.error}`));
  for (const note of app.notes ?? []) {
    console.log(chalk.yellow(`      ${note}`));
  }
  for (const moved of app.endpointMoved ?? []) {
    console.log(chalk.dim(`      ${moved.from} → ${chalk.cyan(moved.to)}`));
  }
}
