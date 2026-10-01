import { formatBytes } from './format-bytes';
import { BackupFileEntry, VolumeBackup } from './volume-backup-client';

function bytes(n: number | null): string {
  return n === null ? '—' : formatBytes(n);
}

function when(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16) + ' UTC';
}

/** One line per backup: the columns `flui app backup list` prints. */
export function volumeBackupColumns(b: VolumeBackup): string[] {
  return [
    b.id.slice(0, 8),
    b.volumeName ?? '—',
    b.engine,
    when(b.createdAt),
    bytes(b.logicalBytes),
    bytes(b.uploadedBytes),
    b.stored,
    b.kept === 'until-deleted' ? 'until deleted' : 'retention',
    b.browsable ? 'yes' : 'no',
  ];
}

export const VOLUME_BACKUP_HEADERS = [
  'ID',
  'VOLUME',
  'ENGINE',
  'TAKEN',
  'SIZE',
  'ADDED',
  'STORED',
  'KEPT',
  'FILES',
];

export function entryColumns(e: BackupFileEntry): string[] {
  const name = e.type === 'directory' ? `${e.name}/` : e.name;
  return [
    e.mode ?? '',
    e.size === null ? '' : formatBytes(e.size),
    when(e.modifiedAt),
    e.consistentCopy ? `${name} (online copy)` : name,
  ];
}

/** Columns padded to their widest cell, two spaces apart. */
export function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
      .join('  ');
  return [line(headers), ...rows.map(line)];
}
