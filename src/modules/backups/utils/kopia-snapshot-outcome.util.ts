import {
  KOPIA_COMPRESSION,
  KOPIA_ENCRYPTION,
  KOPIA_SPLITTER,
  KOPIA_VERSION,
  KopiaSnapshotRecord,
} from './kopia-repository.util';
import { KopiaListedSnapshot, kopiaSourceString } from './kopia-retention.util';

/** What a snapshot Job reported on its way out. */
export interface KopiaSnapshotOutcome {
  primary?: KopiaListedSnapshot;
  sqlite?: KopiaListedSnapshot;
  bytesBefore?: number;
  bytesAfter?: number;
  seconds?: number;
  maintenance?: 'quick' | 'full' | 'failed';
  verified?: 'ok' | 'failed';
  created: boolean;
  listed: KopiaListedSnapshot[];
  sqliteListed: KopiaListedSnapshot[];
}

function marker(log: string, name: string): string | undefined {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(log);
  return match ? match[1].trim() : undefined;
}

function decodeJson<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf-8')) as T;
  } catch {
    return undefined;
  }
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseKopiaSnapshotLog(log: string): KopiaSnapshotOutcome {
  const maintenance = marker(log, 'FLUI_KOPIA_MAINTENANCE');
  const verified = marker(log, 'FLUI_KOPIA_VERIFIED');
  return {
    primary: decodeJson(marker(log, 'FLUI_KOPIA_SNAPSHOT')),
    sqlite: decodeJson(marker(log, 'FLUI_KOPIA_SQLITE_SNAPSHOT')),
    bytesBefore: num(marker(log, 'FLUI_KOPIA_BYTES_BEFORE')),
    bytesAfter: num(marker(log, 'FLUI_KOPIA_BYTES_AFTER')),
    seconds: num(marker(log, 'FLUI_KOPIA_SECONDS')),
    maintenance:
      maintenance === 'quick' ||
      maintenance === 'full' ||
      maintenance === 'failed'
        ? maintenance
        : undefined,
    verified: verified === 'ok' || verified === 'failed' ? verified : undefined,
    created: marker(log, 'FLUI_KOPIA_CREATED') === '1',
    listed:
      decodeJson<KopiaListedSnapshot[]>(marker(log, 'FLUI_KOPIA_SNAPSHOTS')) ??
      [],
    sqliteListed:
      decodeJson<KopiaListedSnapshot[]>(
        marker(log, 'FLUI_KOPIA_SQLITE_SNAPSHOTS'),
      ) ?? [],
  };
}

/** New bytes stored by this snapshot; unknown rather than negative. */
export function uploadedBytes(
  outcome: KopiaSnapshotOutcome,
): number | undefined {
  if (outcome.bytesBefore === undefined || outcome.bytesAfter === undefined) {
    return undefined;
  }
  const delta = outcome.bytesAfter - outcome.bytesBefore;
  return delta >= 0 ? delta : undefined;
}

/** The ledger's record of one snapshot, from what its Job reported. */
export function snapshotRecordFrom(
  outcome: KopiaSnapshotOutcome,
  args: { repositoryPrefix: string; pinned: boolean; now?: Date },
): KopiaSnapshotRecord {
  const primary = outcome.primary;
  if (!primary?.id || !primary.rootEntry?.obj) {
    throw new Error('The kopia Job did not report a snapshot');
  }
  const sourceOf = kopiaSourceString;
  const sqlite = outcome.sqlite;
  return {
    snapshotId: primary.id,
    rootObject: primary.rootEntry.obj,
    source: sourceOf(primary),
    ...(sqlite?.id && sqlite.rootEntry?.obj
      ? {
          sqlite: {
            snapshotId: sqlite.id,
            rootObject: sqlite.rootEntry.obj,
            source: sourceOf(sqlite),
          },
        }
      : {}),
    repositoryPrefix: args.repositoryPrefix,
    logicalBytes:
      (primary.rootEntry.summ?.size ?? 0) +
      (sqlite?.rootEntry?.summ?.size ?? 0),
    fileCount:
      (primary.rootEntry.summ?.files ?? 0) +
      (sqlite?.rootEntry?.summ?.files ?? 0),
    uploadedBytes: uploadedBytes(outcome),
    repositoryBytes: outcome.bytesAfter,
    compression: KOPIA_COMPRESSION,
    encryption: KOPIA_ENCRYPTION,
    splitter: KOPIA_SPLITTER,
    durationSeconds: outcome.seconds,
    pinned: args.pinned,
    ...(outcome.maintenance && outcome.maintenance !== 'failed'
      ? { maintenance: outcome.maintenance }
      : {}),
    ...(outcome.verified === 'ok'
      ? { verifiedAt: (args.now ?? new Date()).toISOString() }
      : {}),
    kopiaVersion: KOPIA_VERSION,
  };
}
