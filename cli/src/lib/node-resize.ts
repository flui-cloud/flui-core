import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from './api-client';
import { findClusterNode } from './cluster-nodes';
import { followOperation } from './follow-operation';
import { confirmByTypingPrompt } from './prompts';
import { archLabel, armWarningLine } from './server-architecture-view';

interface Candidate {
  name: string;
  direction: 'upgrade' | 'downgrade' | 'current';
  monthlyCostEur: string;
  monthlyDeltaEur: string;
  architecture?: string;
  diskGb?: number;
}

interface ResizePreview {
  node: { currentServerType: string };
  affectedDedicatedApps: Array<{ slug: string }>;
  expectedDowntimeMs: number;
  candidates: Candidate[];
  highAvailability: {
    refusal: string | null;
    switchovers: Array<{ namespace: string; cluster: string; target: string }>;
  } | null;
}

export interface NodeResizeFlags {
  type?: string;
  upgradeDisk: boolean;
  copiesGib?: number;
  confirm: boolean;
  wait: boolean;
}

function deltaOf(cand: Candidate): string {
  if (cand.monthlyDeltaEur === 'n/a') return 'n/a';
  const sign = Number.parseFloat(cand.monthlyDeltaEur) > 0 ? '+' : '';
  return `${sign}${cand.monthlyDeltaEur}`;
}

function planLines(
  serverName: string,
  preview: ResizePreview,
  targetType: string,
  cand: Candidate | undefined,
  flags: NodeResizeFlags,
): string[] {
  const arch = cand ? ` (${archLabel(cand.architecture)})` : '';
  const downtime = Math.round(preview.expectedDowntimeMs / 60000);
  const lines = [
    chalk.cyan('\n🖥  Resize plan\n'),
    `   ${chalk.bold('Node:')}        ${serverName}`,
    `   ${chalk.bold('From:')}        ${preview.node.currentServerType}`,
    `   ${chalk.bold('To:')}          ${targetType}${arch}`,
  ];
  if (archLabel(cand?.architecture) === 'arm')
    lines.push(`   ${armWarningLine()}`);
  if (cand) {
    lines.push(
      `   ${chalk.bold('Cost/month:')}  €${cand.monthlyCostEur} (${deltaOf(cand)} delta)`,
    );
  }
  lines.push(`   ${chalk.bold('Downtime:')}    ~${downtime} min for this node`);
  if (flags.copiesGib) {
    lines.push(
      `   ${chalk.bold('Copies:')}      space for copies of replicated volumes grown to ${flags.copiesGib} GiB once the node is back`,
    );
  }
  const apps = preview.affectedDedicatedApps;
  if (apps.length > 0) {
    lines.push(
      chalk.yellow(`\n   ⚠️  Hosts ${apps.length} dedicated workload(s):`),
      ...apps.map((app) => chalk.yellow(`     • ${app.slug}`)),
    );
  }
  return lines;
}

async function confirmNode(serverName: string): Promise<boolean> {
  console.log('');
  console.log(
    chalk.yellow(
      `   To confirm, type the node name exactly: ${chalk.bold(serverName)}`,
    ),
  );
  const ok = await confirmByTypingPrompt(
    chalk.yellow('⚠️  Node name'),
    serverName,
  );
  if (!ok) console.log(chalk.green('\n✅ Cancelled\n'));
  return ok;
}

async function followResize(
  api: ApiClient,
  operationId: string,
  serverName: string,
  targetType: string,
): Promise<boolean> {
  const run = ora({
    text: `Resizing ${serverName} to ${targetType}...`,
    color: 'yellow',
  }).start();
  const done = await followOperation<{ message?: string }>(api, operationId, {
    onUpdate: (o) => {
      if (o.metadata?.message) run.text = String(o.metadata.message);
    },
  });
  if (done?.status === 'COMPLETED') {
    run.succeed(`${serverName} is now ${targetType}. Operation ${operationId}`);
    return true;
  }
  const status = done?.status?.toLowerCase() ?? 'still running';
  const detail =
    done?.errorMessage ?? `follow it with flui operation ${operationId}`;
  run.fail(`Resize ${status}: ${detail}`);
  return false;
}

/**
 * Shows what a resize of one node would do, asks for the node's name, queues
 * it and follows the operation to its end. Returns false when nothing was
 * done or the resize failed.
 */
export async function resizeNode(
  api: ApiClient,
  clusterId: string,
  nodeRef: string,
  flags: NodeResizeFlags,
): Promise<boolean> {
  const base = `/infrastructure/clusters/${clusterId}`;
  const target = await findClusterNode(api, clusterId, nodeRef);
  const preview = await api.get<ResizePreview>(
    `${base}/nodes/${target.id}/scale/preview`,
  );

  const cand = flags.type
    ? preview.candidates.find((c) => c.name === flags.type)
    : preview.candidates.find((c) => c.direction === 'upgrade');
  const targetType = flags.type ?? cand?.name;
  if (!targetType) {
    console.log(
      chalk.red('\n❌ No bigger type is offered for this node. Pass --type.\n'),
    );
    return false;
  }
  if (!flags.type) {
    console.log(
      chalk.dim(
        `   (next bigger type for this node: ${chalk.bold(targetType)})`,
      ),
    );
  }
  for (const line of planLines(
    target.serverName,
    preview,
    targetType,
    cand,
    flags,
  )) {
    console.log(line);
  }

  const ha = preview.highAvailability;
  if (ha?.refusal) {
    console.log(chalk.red(`\n❌ ${ha.refusal}\n`));
    return false;
  }
  for (const s of ha?.switchovers ?? []) {
    console.log(
      chalk.dim(
        `   The primary of ${s.namespace}/${s.cluster} moves to ${s.target} first; writes pause for a few seconds.`,
      ),
    );
  }
  if (!flags.confirm && !(await confirmNode(target.serverName))) return false;

  const op = await api.post<{ id: string }>(
    `${base}/nodes/${target.id}/scale`,
    {
      targetServerType: targetType,
      upgradeDisk: flags.upgradeDisk,
      ...(flags.copiesGib && { copiesGiB: flags.copiesGib }),
    },
  );
  if (!flags.wait) {
    console.log(`\n   Resize queued. Operation ${op.id}\n`);
    return true;
  }
  return followResize(api, op.id, target.serverName, targetType);
}
