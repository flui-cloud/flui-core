export interface MigrationLink {
  state: 'open' | 'closing' | 'closed';
  listenerNode: string | null;
  dialerNode: string | null;
  handshakeSeen: boolean;
  lastHandshakeAt?: string | null;
}

export interface MigrationFence {
  appliedAt: string | null;
  fenceLsn: string | null;
  promoteIssuedAt: string | null;
  released: boolean;
  releasedAt?: string | null;
  releaseNote?: string | null;
}

export interface MigrationBaseBackup {
  phase: 'waiting' | 'copying' | 'done' | 'failed' | 'aborted';
  lagBytes: number | null;
}

export interface MigrationPoolerCut {
  paused: boolean;
  pausedAt: string | null;
  resumedAt: string | null;
  resumedBy?: 'rollback' | 'abort' | 'retarget' | null;
  sourceLeftPaused?: boolean;
  deadlineMs: number;
  cut: Array<{ clientApp: string | null; heldMs: number | null }>;
}

export interface MigrationNextStep {
  key: string;
  text: string;
}

/** The read-side fields the API adds to db and full migrations. */
export interface MigrationMeasures {
  kind?: 'logical' | 'physical' | null;
  link?: MigrationLink | null;
  fence?: MigrationFence | null;
  pooler?: MigrationPoolerCut | null;
  baseBackup?: MigrationBaseBackup | null;
  sourceWalCap?: { value: string; note: string | null } | null;
  writePauseMs?: number | null;
  writePauseEndedBy?: 'bridge' | 'dns' | 'promote' | 'resume' | null;
  interruptionMs?: number | null;
  nextSteps?: MigrationNextStep[];
}

const ENDED_BY: Record<string, string> = {
  bridge: 'until the bridge forwarded to the destination',
  dns: 'until DNS moved to the destination',
  promote: 'until the destination was promoted',
  resume: 'writes waited in the poolers, none failed',
};

type Row = [string, string];

/** Label/value rows for `migrate db|full show`, straight from the API's fields. */
export function measureRows(m: MigrationMeasures): [string, string][] {
  const rows: Row[] = [];
  if (m.kind) rows.push(['Kind', m.kind]);
  if (m.link) rows.push(['Link', linkText(m.link)]);
  if (m.baseBackup) rows.push(['Copy', copyText(m.baseBackup)]);
  if (m.sourceWalCap) {
    rows.push(['WAL cap', m.sourceWalCap.value]);
    if (m.sourceWalCap.note) rows.push(['', m.sourceWalCap.note]);
  }
  if (m.fence) rows.push(...fenceRows(m.fence));
  if (m.pooler) rows.push(...poolerRows(m.pooler));
  if (m.writePauseMs != null) {
    const ended = m.writePauseEndedBy
      ? ENDED_BY[m.writePauseEndedBy]
      : 'until the destination was promoted';
    rows.push(['Write pause', `${seconds(m.writePauseMs)} (${ended})`]);
  }
  if (m.interruptionMs != null) {
    rows.push([
      'Interruption',
      `${seconds(m.interruptionMs)} (stopped while its volumes moved)`,
    ]);
  }
  (m.nextSteps ?? []).forEach((step, i) =>
    rows.push([i === 0 ? 'Next' : '', step.text]),
  );
  return rows;
}

function linkText(link: MigrationLink): string {
  const listener = link.listenerNode ?? 'unknown node';
  const dialer = link.dialerNode ?? 'unknown node';
  const handshake = link.handshakeSeen ? 'seen' : 'not seen';
  return `${link.state}, ${listener} listens, ${dialer} dials, handshake ${handshake}`;
}

function copyText(baseBackup: MigrationBaseBackup): string {
  return baseBackup.lagBytes != null
    ? `${baseBackup.phase}, ${baseBackup.lagBytes} bytes to replay`
    : baseBackup.phase;
}

function fenceRows(fence: MigrationFence): Row[] {
  const parts = [fence.appliedAt ? `applied ${fence.appliedAt}` : 'applied'];
  if (fence.fenceLsn) parts.push(`LSN ${fence.fenceLsn}`);
  if (fence.promoteIssuedAt) {
    parts.push(`promote asked ${fence.promoteIssuedAt}`);
  }
  parts.push(fence.released ? 'released' : 'held');
  const rows: Row[] = [['Fence', parts.join(', ')]];
  if (fence.releaseNote) rows.push(['', fence.releaseNote]);
  return rows;
}

function poolerRows(pooler: MigrationPoolerCut): Row[] {
  const parts = [
    pooler.pausedAt ? `paused ${pooler.pausedAt}` : 'not paused yet',
  ];
  if (pooler.resumedAt) {
    const by =
      pooler.resumedBy && pooler.resumedBy !== 'retarget'
        ? ` by ${pooler.resumedBy}`
        : '';
    parts.push(`resumed ${pooler.resumedAt}${by}`);
  } else if (pooler.paused) parts.push('still paused');
  parts.push(`deadline ${seconds(pooler.deadlineMs)}`);
  const rows: Row[] = [['Pooler', parts.join(', ')]];
  if (pooler.sourceLeftPaused) rows.push(['', 'source pooler left paused']);
  pooler.cut.forEach((c, i) => {
    const held =
      c.heldMs != null ? ` (transaction open about ${seconds(c.heldMs)})` : '';
    rows.push([
      i === 0 ? 'Cut' : '',
      `${c.clientApp || 'unnamed client'}${held}`,
    ]);
  });
  return rows;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The label column of `show`, one space wider when a label outgrows it. */
export function labelCell(label: string): string {
  const cell = label ? `${label}:` : '';
  return cell.length >= 12 ? `${cell} ` : cell.padEnd(12);
}
