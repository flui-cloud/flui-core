import { KOPIA_SINK, KopiaSnapshotRecord } from './kopia-repository.util';
import { isCryptSummary } from './rclone-crypt.util';

/** One entry of a kopia directory object, as `kopia show` prints it. */
export interface KopiaDirectoryEntry {
  name: string;
  /** `d` directory, `f` file, `s` symlink. */
  type: string;
  mode?: string;
  size?: number;
  mtime?: string;
  obj?: string;
  summ?: { size?: number; files?: number; dirs?: number };
}

export interface BackupFileEntry {
  name: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
  size: number | null;
  modifiedAt: string | null;
  mode: string | null;
  /** Taken with SQLite's online backup rather than read as a file. */
  consistentCopy?: boolean;
}

const MAX_PATH_LENGTH = 4096;

/**
 * A path inside a backed-up volume, as segments.
 *
 * Relative to the volume root whatever the caller wrote: leading and trailing
 * slashes are dropped, and `.`/`..` are refused rather than resolved, because a
 * path that climbs is never a path inside the volume.
 */
export function splitBackupPath(path: string | undefined | null): string[] {
  const raw = (path ?? '').trim();
  if (raw.length > MAX_PATH_LENGTH) throw new Error('The path is too long');
  if (/[\0\r\n]/.test(raw))
    throw new Error('The path contains a control character');
  const segments = raw.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) {
    throw new Error('The path may not contain "." or ".." segments');
  }
  return segments;
}

export function normalizeBackupPath(path: string | undefined | null): string {
  return splitBackupPath(path).join('/');
}

/** A restore of selected paths: at least one, each inside the volume, no repeats. */
export function normalizeRestorePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('Name at least one path to restore');
  }
  if (paths.length > 200) throw new Error('At most 200 paths per restore');
  const out = paths.map((p) => {
    if (typeof p !== 'string') throw new Error('Paths must be strings');
    const normalized = normalizeBackupPath(p);
    if (!normalized) {
      throw new Error(
        'The volume root is not a path to restore; restore the whole backup instead',
      );
    }
    return normalized;
  });
  return [...new Set(out)];
}

function kindOf(type: string): BackupFileEntry['type'] {
  if (type === 'd') return 'directory';
  if (type === 'f') return 'file';
  if (type === 's') return 'symlink';
  return 'other';
}

function toEntry(
  e: KopiaDirectoryEntry,
  consistentCopy: boolean,
): BackupFileEntry {
  const size = e.type === 'd' ? (e.summ?.size ?? null) : (e.size ?? null);
  return {
    name: e.name,
    type: kindOf(e.type),
    size,
    modifiedAt: e.mtime ?? null,
    mode: e.mode ?? null,
    ...(consistentCopy ? { consistentCopy: true } : {}),
  };
}

/**
 * The volume as it restores: the SQLite copies laid over the volume's own
 * snapshot, which left the live database files out. A name in both is the
 * copy's, because that is the file a restore writes last.
 */
export function mergeBackupListings(
  primary: ReadonlyArray<KopiaDirectoryEntry>,
  overlay: ReadonlyArray<KopiaDirectoryEntry> = [],
): BackupFileEntry[] {
  const byName = new Map<string, BackupFileEntry>();
  for (const e of primary) byName.set(e.name, toEntry(e, false));
  for (const e of overlay) {
    const existing = byName.get(e.name);
    if (existing?.type === 'directory' && e.type === 'd') continue;
    byName.set(e.name, toEntry(e, e.type !== 'd'));
  }
  return [...byName.values()].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (b.type === 'directory' && a.type !== 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
}

export type VolumeRestoreRoute =
  | { kind: 'kopia'; record: KopiaSnapshotRecord }
  | { kind: 's3-archive'; objectKeyPrefix: string; encrypted: boolean }
  | { kind: 'pvc-clone'; clonePvcName: string }
  | { kind: 'unavailable'; reason: string };

interface RestorableArtifact {
  engineClass?: string;
  engine?: string | null;
  engineRef?: string | null;
  manifestSummary?: Record<string, any> | null;
  locations?: Array<{ state: string; objectKeyPrefix?: string }> | null;
}

const GONE = new Set(['expired', 'missing', 'failed']);

/**
 * Which mechanism brings a volume backup back.
 *
 * A kopia snapshot restores through kopia; an rclone archive written before
 * kopia keeps its own path until it expires, and a clone is restored from the
 * cluster with `app snapshot restore`. Decided from the row, never from what
 * the destination looks like today.
 */
export function volumeRestoreRoute(
  artifact: RestorableArtifact,
): VolumeRestoreRoute {
  if (artifact.engineClass && artifact.engineClass !== 'volume_copy') {
    return { kind: 'unavailable', reason: 'This is not a volume backup' };
  }
  const summary = artifact.manifestSummary ?? {};
  const locations = artifact.locations ?? [];
  const gone =
    locations.length > 0 && locations.every((l) => GONE.has(l.state));
  if (summary.sink === KOPIA_SINK || artifact.engine === KOPIA_SINK) {
    const record = summary.kopia as KopiaSnapshotRecord | undefined;
    if (!record?.snapshotId) {
      return {
        kind: 'unavailable',
        reason: 'The backup names no kopia snapshot',
      };
    }
    if (gone) {
      return {
        kind: 'unavailable',
        reason: 'kopia no longer keeps this snapshot: retention removed it',
      };
    }
    return { kind: 'kopia', record };
  }
  if (summary.sink === 's3-archive') {
    const prefix =
      (summary.repository?.objectKeyPrefix as string | undefined) ||
      locations.find((l) => l.objectKeyPrefix)?.objectKeyPrefix ||
      artifact.engineRef ||
      '';
    if (!prefix) {
      return {
        kind: 'unavailable',
        reason: 'The archive has no recorded location',
      };
    }
    if (gone) {
      return { kind: 'unavailable', reason: 'The archive is no longer stored' };
    }
    return {
      kind: 's3-archive',
      objectKeyPrefix: prefix,
      encrypted: isCryptSummary(summary),
    };
  }
  if (summary.sink === 'pvc-clone') {
    return {
      kind: 'pvc-clone',
      clonePvcName:
        (summary.clonePvcName as string) || artifact.engineRef || '',
    };
  }
  return { kind: 'unavailable', reason: 'Unknown volume backup kind' };
}

/** One volume backup as the CLI, the dashboard and the MCP tools show it. */
export interface VolumeBackupView {
  id: string;
  volumeName: string | null;
  engine: 'kopia' | 'rclone' | 'pvc-clone' | 'unknown';
  createdAt: string | null;
  /** Pinned kopia snapshots and hand-taken copies stay until a person removes them. */
  kept: 'retention' | 'until-deleted';
  /** What a restore writes back. */
  logicalBytes: number | null;
  /** What this backup added to the destination. */
  uploadedBytes: number | null;
  stored: 'present' | 'expired' | 'missing' | 'unknown';
  encrypted: boolean;
  restorable: boolean;
  /** Whether single files can be listed and restored from it. */
  browsable: boolean;
  reason: string | null;
  quiesce: string | null;
  snapshotId: string | null;
  destinationId: string | null;
}

interface ViewableArtifact extends RestorableArtifact {
  id: string;
  volumeName?: string | null;
  createdAt?: Date | string | null;
  sizeBytes?: string | number | null;
  expiresAt?: Date | string | null;
  backupJobId?: string;
  locations?: Array<{
    state: string;
    objectKeyPrefix?: string;
    destinationId?: string;
    bytesStored?: string | number | null;
    role?: string;
  }> | null;
}

/**
 * The copy a restore reads. A replica of a kopia repository is encrypted with
 * the key derived from the primary destination's passphrase, so the primary
 * location is the one whose destination opens it.
 */
export function primaryLocationOf<L extends { role?: string }>(artifact: {
  locations?: L[] | null;
}): L | undefined {
  const locations = artifact.locations ?? [];
  return locations.find((l) => l.role === 'primary') ?? locations[0];
}

const PRESENT_STATES = new Set(['available', 'verified']);

function storedOf(a: ViewableArtifact, now: Date): VolumeBackupView['stored'] {
  const states = (a.locations ?? []).map((l) => l.state);
  const expiresAt = a.expiresAt ? new Date(a.expiresAt) : null;
  if (states.includes('expired') || (expiresAt && expiresAt <= now)) {
    return 'expired';
  }
  if (states.some((s) => PRESENT_STATES.has(s))) return 'present';
  if (a.manifestSummary?.sink === 'pvc-clone') return 'present';
  if (states.some((s) => GONE.has(s))) return 'missing';
  return 'unknown';
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function keptUntil(expires: boolean): VolumeBackupView['kept'] {
  return expires ? 'retention' : 'until-deleted';
}

export function toVolumeBackupView(
  artifact: ViewableArtifact,
  now: Date = new Date(),
): VolumeBackupView {
  const summary = artifact.manifestSummary ?? {};
  const route = volumeRestoreRoute(artifact);
  const record = summary.kopia as KopiaSnapshotRecord | undefined;
  let engine: VolumeBackupView['engine'] = 'unknown';
  if (summary.sink === KOPIA_SINK) engine = 'kopia';
  else if (summary.sink === 's3-archive') engine = 'rclone';
  else if (summary.sink === 'pvc-clone') engine = 'pvc-clone';
  const location = primaryLocationOf(artifact);
  const uploaded =
    record?.uploadedBytes ?? numberOrNull(location?.bytesStored ?? null);
  const kept = keptUntil(
    engine === 'kopia' ? !record?.pinned : Boolean(artifact.expiresAt),
  );
  const created = artifact.createdAt ? new Date(artifact.createdAt) : null;
  return {
    id: artifact.id,
    volumeName: artifact.volumeName ?? null,
    engine,
    createdAt: created ? created.toISOString() : null,
    kept,
    logicalBytes: record?.logicalBytes ?? numberOrNull(artifact.sizeBytes),
    uploadedBytes: uploaded ?? null,
    stored: storedOf(artifact, now),
    encrypted:
      engine === 'kopia' || isCryptSummary(summary as Record<string, unknown>),
    restorable: route.kind !== 'unavailable',
    browsable: route.kind === 'kopia',
    reason: route.kind === 'unavailable' ? route.reason : null,
    quiesce: (summary.quiesce as string | undefined) ?? null,
    snapshotId: record?.snapshotId ?? null,
    destinationId: location?.destinationId ?? null,
  };
}
