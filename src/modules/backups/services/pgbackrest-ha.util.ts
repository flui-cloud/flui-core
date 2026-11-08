import {
  RESTORE_POINT_MARKER,
  restorePointLabel,
} from '../utils/restore-point.util';

/** Where the Stanza records the repository it ships to, relative to the destination. */
export const REPOSITORY_ANNOTATION = 'flui.cloud/repository-prefix';

/**
 * A highly available database's repository, beside the single instance's
 * under the same application: one per move to high availability, because
 * the instance it was copied from shipped to its own until the move.
 */
export function haRepositoryPrefix(appId: string, generation?: string): string {
  return `pgbackrest/${appId}/ha-${generation ?? 'current'}/`;
}

const psql = `psql -U postgres -v ON_ERROR_STOP=1 -tA`;

/** The moment the last segment reached the repository, in the marker the single instance's info reads. */
export function haArchivedEdgeScript(): string {
  return `echo "FLUI_LAST_ARCHIVED=$(${psql} -c "SELECT coalesce(floor(extract(epoch from last_archived_time))::bigint, 0) FROM pg_stat_archiver")"`;
}

/** A named restore point on the primary, then a segment switch so it ships now. */
export function haRestorePointScript(label: string): string {
  return [
    'set -e',
    `MARK="$(${psql} -F ' ' -c "SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint, pg_create_restore_point('${restorePointLabel(label)}')")"`,
    `${psql} -c "SELECT pg_switch_wal()" >/dev/null`,
    `echo "${RESTORE_POINT_MARKER}$MARK"`,
  ].join('\n');
}

/**
 * The copy carries the single instance's `postgresql.auto.conf`, where Flui
 * pointed `archive_command` at a pgBackRest configuration the cluster's image
 * does not have; read last, it would win over the operator's own command.
 */
export const CLEAR_COPIED_ARCHIVE_SETTINGS = [
  'sed -i -E "/^(archive_command|archive_timeout)[[:space:]]*=/d" "$PGDATA/postgresql.auto.conf"',
  `${psql} -c "SELECT pg_reload_conf()" >/dev/null`,
].join('\n');

export const SWITCH_SEGMENT = `${psql} -c "SELECT pg_walfile_name(pg_switch_wal())"`;

/** `archived` once the segment reached the repository; the last failure otherwise. */
export function archivedSince(segment: string): string {
  return `${psql} -F '|' -c "SELECT last_archived_wal >= '${segment}', coalesce(last_failed_wal, '') FROM pg_stat_archiver"`;
}

export function parseArchivedSince(out: string): {
  archived: boolean;
  failed: string;
} {
  const [archived, failed] = out.trim().split('\n').pop()!.split('|');
  return { archived: archived === 't', failed: failed ?? '' };
}

interface StanzaBackup {
  label?: string;
  type?: string;
  timestamp?: { start?: number; stop?: number };
}

/**
 * The repository's bases as the plugin records them on its Stanza: the first
 * and the last, and how many of each type. The newest full is the last backup
 * when it is one, otherwise no later than the first, which is how a cadence
 * errs towards a full too early rather than too late.
 */
export function infoFromStanza(
  status:
    | {
        backupsCount?: { Full?: number; Incr?: number; Diff?: number };
        recoveryWindow?: {
          firstBackup?: StanzaBackup;
          lastBackup?: StanzaBackup;
        };
      }
    | null
    | undefined,
): {
  latestLabel: string | null;
  oldestRecoverable: string | null;
  newestRecoverable: string | null;
  lastFullAt: string | null;
  backupCount: number;
  latestSizeBytes: null;
} {
  const count = status?.backupsCount ?? {};
  const backupCount = (count.Full ?? 0) + (count.Incr ?? 0) + (count.Diff ?? 0);
  const first = status?.recoveryWindow?.firstBackup;
  const last = status?.recoveryWindow?.lastBackup;
  const at = (b?: StanzaBackup) =>
    b?.timestamp?.stop ? new Date(b.timestamp.stop * 1000).toISOString() : null;
  if (!backupCount || !last?.label) {
    return {
      latestLabel: null,
      oldestRecoverable: null,
      newestRecoverable: null,
      lastFullAt: null,
      backupCount: 0,
      latestSizeBytes: null,
    };
  }
  return {
    latestLabel: last.label,
    oldestRecoverable: at(first),
    newestRecoverable: at(last),
    lastFullAt: at(last.type === 'full' ? last : first),
    backupCount,
    latestSizeBytes: null,
  };
}
