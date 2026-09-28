import chalk from 'chalk';

export interface UpgradePlanBlockerView {
  phase: string;
  message: string;
  overridable?: boolean;
}

export interface UpgradePlanClusterView {
  clusterId: string;
  clusterName: string;
  clusterType: 'control' | 'workload';
  files?: Array<{ name: string; action: string }>;
  leftAlone?: number;
  steps?: string[];
  fromVersion?: string | null;
  upToDate: boolean;
  blockers: string[];
}

export interface UpgradePlanPhaseView {
  key: string;
  title: string;
  willRun: boolean;
  summary: string;
  blockers: UpgradePlanBlockerView[];
  clusters?: UpgradePlanClusterView[];
}

export interface UpgradePlanView {
  planId: string;
  fromVersion: string;
  targetVersion: string;
  bootstrapRef: string;
  k3sVersion: string | null;
  migrations: number;
  phases: UpgradePlanPhaseView[];
  advisories: Array<{ level: string; title: string; detail: string }>;
  blockers: UpgradePlanBlockerView[];
  applicable: boolean;
  acknowledgement: string;
}

export interface UpgradeNodeView {
  name: string;
  role: string;
  fromVersion: string | null;
  version: string | null;
  status: string;
  message?: string;
}

export interface UpgradePhaseClusterView {
  clusterId: string;
  clusterName: string;
  clusterType: string;
  status: string;
  steps?: string[];
  stepIndex?: number;
  nodes?: UpgradeNodeView[];
  error?: string;
}

export interface UpgradeOperationView {
  id: string;
  status: string;
  fromVersion: string;
  targetVersion: string;
  schema?: number;
  awaitingSelfRestart: boolean;
  withoutBackup?: boolean;
  errorMessage: string | null;
  guidance?: string | null;
  phases?: Array<{
    key: string;
    title: string;
    status: string;
    backupJobId?: string | null;
    clusters?: UpgradePhaseClusterView[];
    checks?: Array<{ name: string; ok: boolean; detail?: string }>;
    error?: string;
  }>;
  components?: Array<{ name: string; status: string; targetVersion: string }>;
}

const TONE: Record<string, (t: string) => string> = {
  done: chalk.green,
  skipped: chalk.dim,
  running: chalk.yellow,
  upgrading: chalk.yellow,
  pending: chalk.dim,
  failed: chalk.red,
};

const tone = (status: string) => (TONE[status] ?? ((t: string) => t))(status);

export function applyCommand(
  plan: UpgradePlanView,
  withoutBackup: boolean,
): string {
  const skipBackup = withoutBackup ? ' --without-backup' : '';
  return `flui env upgrade --to ${plan.targetVersion} --plan ${plan.planId} --apply${skipBackup}`;
}

function manifestsLine(name: string, cluster: UpgradePlanClusterView): string {
  const files = cluster.files ?? [];
  const count = files.length
    ? `${files.length} file(s)`
    : chalk.green('already in line');
  const leftAlone = cluster.leftAlone
    ? chalk.dim(` · ${cluster.leftAlone} left alone`)
    : '';
  return `      ${name}  ${count}${leftAlone}`;
}

function clusterLines(
  phase: UpgradePlanPhaseView,
  cluster: UpgradePlanClusterView,
): string[] {
  const type = chalk.dim(`(${cluster.clusterType})`);
  const name = `${cluster.clusterName} ${type}`;
  const out: string[] = [];
  if (phase.key === 'k3s') {
    const path = cluster.upToDate
      ? chalk.green('already there')
      : `${cluster.fromVersion ?? '?'} → ${(cluster.steps ?? []).join(' → ')}`;
    out.push(`      ${name}  ${path}`);
  } else if (phase.key === 'manifests') {
    out.push(
      manifestsLine(name, cluster),
      ...(cluster.files ?? []).map((f) =>
        chalk.dim(`        ${f.action.padEnd(8)} ${f.name}`),
      ),
    );
  }
  for (const b of cluster.blockers) out.push(chalk.red(`        ✗ ${b}`));
  return out;
}

function planHeader(plan: UpgradePlanView): string {
  const title = chalk.bold(`Flui ${plan.fromVersion} → ${plan.targetVersion}`);
  const k3s = plan.k3sVersion ? ` · K3s ${plan.k3sVersion}` : '';
  const manifests = chalk.dim(`manifests ${plan.bootstrapRef}${k3s}`);
  return `   ${title} ${manifests}`;
}

export function renderUpgradePlan(
  plan: UpgradePlanView,
  opts: { cluster?: string; withoutBackup?: boolean } = {},
): string[] {
  const out: string[] = ['', planHeader(plan), ''];
  plan.phases.forEach((phase, i) => {
    const mark = phase.willRun ? '' : chalk.dim(' (nothing to do)');
    out.push(
      `   ${i + 1}. ${chalk.bold(phase.title)}${mark}`,
      chalk.dim(`      ${phase.summary}`),
    );
    const clusters = (phase.clusters ?? []).filter(
      (c) =>
        !opts.cluster ||
        c.clusterId === opts.cluster ||
        c.clusterName === opts.cluster,
    );
    for (const c of clusters) out.push(...clusterLines(phase, c));
  });

  if (plan.advisories.length) {
    out.push(
      '',
      ...plan.advisories.map((a) => `   ${chalk.yellow('!')} ${a.title}`),
    );
  }

  const hard = plan.blockers.filter((b) => !b.overridable);
  const soft = plan.blockers.filter((b) => b.overridable);
  if (hard.length) {
    out.push(
      '',
      `   ${chalk.red('Cannot be applied yet:')}`,
      ...hard.map((b) => chalk.red(`     ✗ ${b.message}`)),
      '',
    );
    return out;
  }
  if (soft.length) {
    out.push(
      '',
      ...soft.map((b) => `   ${chalk.yellow('!')} ${b.message}`),
      chalk.dim(
        `   To go on without it, add --without-backup; it records: "${plan.acknowledgement}"`,
      ),
    );
  }
  out.push(
    '',
    `   ${chalk.dim('plan')} ${chalk.bold(plan.planId)}`,
    chalk.dim(
      `   To apply: ${applyCommand(plan, soft.length > 0 || !!opts.withoutBackup)}`,
    ),
    '',
  );
  return out;
}

type OperationPhaseView = NonNullable<UpgradeOperationView['phases']>[number];

function operationHeader(op: UpgradeOperationView): string[] {
  const title = chalk.bold(`Flui ${op.fromVersion} → ${op.targetVersion}`);
  const out = [
    '',
    `   ${title}  ${tone(op.status.toLowerCase())} ${chalk.dim(op.id)}`,
  ];
  if (op.withoutBackup) {
    out.push(chalk.yellow('   Applied without a backup, by acknowledgement.'));
  }
  if (op.awaitingSelfRestart) {
    out.push(
      chalk.yellow(
        '   The API is being replaced; it answers again in a minute.',
      ),
    );
  }
  out.push('');
  return out;
}

function currentStep(c: UpgradePhaseClusterView): string {
  if (!c.steps?.length) return '';
  const step = c.steps[Math.min(c.stepIndex ?? 0, c.steps.length - 1)];
  return chalk.dim(` ${step}`);
}

function nodeLine(n: UpgradeNodeView): string {
  const message = n.message ? chalk.red(` ${n.message}`) : '';
  return `       ${chalk.dim(n.role.padEnd(6))} ${n.name.padEnd(26)} ${chalk.dim(n.version ?? '?')} ${tone(n.status)}${message}`;
}

function operationClusterLines(c: UpgradePhaseClusterView): string[] {
  const out = [
    `     ${c.clusterName.padEnd(34)} ${tone(c.status)}${currentStep(c)}`,
    ...(c.nodes ?? []).map(nodeLine),
  ];
  if (c.error) out.push(chalk.red(`       ${c.error}`));
  return out;
}

function checkLine(check: {
  name: string;
  ok: boolean;
  detail?: string;
}): string {
  const mark = check.ok ? chalk.green('✓') : chalk.red('✗');
  const detail = check.detail ? chalk.dim(` ${check.detail}`) : '';
  return `     ${mark} ${check.name}${detail}`;
}

function operationPhaseLines(phase: OperationPhaseView): string[] {
  const extra =
    phase.key === 'backup' && phase.backupJobId
      ? chalk.dim(` backup ${phase.backupJobId}`)
      : '';
  return [
    `   ${phase.title.padEnd(36)} ${tone(phase.status)}${extra}`,
    ...(phase.clusters ?? []).flatMap(operationClusterLines),
    ...(phase.checks ?? []).map(checkLine),
  ];
}

function failureLines(op: UpgradeOperationView): string[] {
  const out = [''];
  if (op.errorMessage) out.push(chalk.red(`   ${op.errorMessage}`));
  if (op.guidance && !op.errorMessage?.includes(op.guidance)) {
    out.push(`   ${op.guidance}`);
  }
  if (op.schema === 2) {
    out.push(chalk.dim(`   Once fixed: flui env upgrade --resume ${op.id}`));
  }
  return out;
}

export function renderUpgradeOperation(op: UpgradeOperationView): string[] {
  const out = operationHeader(op);
  if (!op.phases) {
    for (const c of op.components ?? []) {
      out.push(`   ${c.name.padEnd(14)} ${tone(c.status)}`);
    }
  }
  for (const phase of op.phases ?? []) out.push(...operationPhaseLines(phase));
  if (op.status === 'FAILED') out.push(...failureLines(op));
  out.push('');
  return out;
}

export const WITHOUT_BACKUP_SENTENCE =
  'Without a backup, a database migration cannot be undone.';

const sameSentence = (text: string | undefined) =>
  typeof text === 'string' &&
  text.trim().toLowerCase() === WITHOUT_BACKUP_SENTENCE.toLowerCase();

/**
 * The acknowledgement for skipping the backup comes from the person — typed at
 * the prompt, or given with `--acknowledge` — never from the CLI itself.
 */
export async function backupAcknowledgement(opts: {
  withoutBackup: boolean;
  acknowledge?: string;
  canAsk: boolean;
  ask: (sentence: string) => Promise<string>;
}): Promise<{ acknowledgement?: string; error?: string }> {
  if (!opts.withoutBackup) return {};
  const refusal = `Going without a backup needs the sentence, typed: --acknowledge "${WITHOUT_BACKUP_SENTENCE}"`;
  if (opts.acknowledge !== undefined) {
    return sameSentence(opts.acknowledge)
      ? { acknowledgement: WITHOUT_BACKUP_SENTENCE }
      : { error: refusal };
  }
  if (!opts.canAsk) return { error: refusal };
  const typed = await opts.ask(WITHOUT_BACKUP_SENTENCE);
  return sameSentence(typed)
    ? { acknowledgement: WITHOUT_BACKUP_SENTENCE }
    : { error: 'The sentence did not match; nothing was started.' };
}
