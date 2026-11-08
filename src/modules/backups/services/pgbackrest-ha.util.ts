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
