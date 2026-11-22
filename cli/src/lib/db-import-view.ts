export interface DbImportView {
  id: string;
  engine: 'postgres' | 'mariadb';
  status:
    | 'checking'
    | 'copying'
    | 'streaming'
    | 'cutting-over'
    | 'completed'
    | 'failed'
    | 'aborted';
  source: { host: string; port: number; database: string; user: string };
  tablesTotal: number | null;
  tablesCopied: number | null;
  lagBytes: number | null;
  lagSeconds: number | null;
  tablesWithoutKey: string[];
  detail: string | null;
}

const STATE: Record<DbImportView['status'], string> = {
  checking: 'Checking the source and copying the schema',
  copying: 'Copying the tables',
  streaming: 'Copied; new changes on the source follow here',
  'cutting-over': 'Switching: waiting for the last changes, then detaching',
  completed: 'Imported; detached from the source',
  failed: 'Failed',
  aborted: 'Cancelled',
};

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function importLines(v: DbImportView, ref: string): string[] {
  const s = v.source;
  const lines = [
    `   From:   ${s.user}@${s.host}:${s.port}/${s.database}`,
    `   State:  ${STATE[v.status]}`,
  ];
  if (v.tablesTotal !== null) {
    lines.push(`   Tables: ${v.tablesCopied ?? 0} of ${v.tablesTotal} copied`);
  }
  const following = ['copying', 'streaming', 'cutting-over'].includes(v.status);
  if (following && v.lagSeconds !== null) {
    lines.push(`   Behind: ${v.lagSeconds} s`);
  } else if (following && v.lagBytes !== null) {
    lines.push(
      `   Behind: ${humanBytes(v.lagBytes)} of changes not yet applied`,
    );
  }
  if (v.tablesWithoutKey.length) {
    lines.push(
      `   Without a primary key, given a full replica identity on the source until the end: ${v.tablesWithoutKey.join(', ')}`,
    );
  }
  if (v.detail) lines.push(`   ${v.detail}`);
  if (v.status === 'streaming') {
    lines.push(
      '',
      '   When you are ready: stop every write to the source, then',
      `   flui db import ${ref} --switch`,
    );
  }
  return lines;
}
