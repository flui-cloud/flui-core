import {
  KOPIA_API_USER,
  KopiaS3Location,
  KopiaSnapshotRecord,
} from './kopia-repository.util';
import { kopiaConnectScript, kopiaLocationEnv } from './kopia-job.manifest';

/**
 * The secret half of a kopia restore during a rebuild, as the names it takes
 * in the application's own Secret.
 *
 * Prefixed rather than kopia's and the S3 SDK's own names: the application's
 * container inherits the same Secret until the next deploy renders it clean,
 * and an `AWS_ACCESS_KEY_ID` there would be picked up by any AWS client the
 * application runs.
 */
export const KOPIA_RESTORE_PASSWORD_ENV = 'FLUI_RESTORE_KOPIA_PASSWORD';
export const KOPIA_RESTORE_ACCESS_KEY_ENV = 'FLUI_RESTORE_KOPIA_ACCESS_KEY';
export const KOPIA_RESTORE_SECRET_KEY_ENV = 'FLUI_RESTORE_KOPIA_SECRET_KEY';

/** Where the init container keeps kopia's configuration and cache. */
export const KOPIA_RESTORE_WORK_MOUNT = '/flui/work';

/**
 * Fills one volume from a kopia snapshot before the application's container
 * may start: the volume's own snapshot, then the SQLite copies laid over it —
 * the same order a restore Job uses, so the database files are the consistent
 * copies and not whatever the first snapshot left out.
 *
 * Read-only and as the API's identity, never the Jobs': the repository's
 * maintenance owner stays the one identity that writes. The marker makes a
 * restarted pod a no-op instead of a second restore over what the
 * application has written since; a restore that died halfway leaves no marker
 * and is simply done again, kopia overwriting what it had already written.
 */
export function kopiaRebuildRestoreScript(mount: string): string {
  return [
    'set -eu',
    `d=${mount}`,
    'if [ -f "$d/.flui-restored" ]; then echo "flui: already restored"; exit 0; fi',
    `export KOPIA_PASSWORD="$${KOPIA_RESTORE_PASSWORD_ENV}" AWS_ACCESS_KEY_ID="$${KOPIA_RESTORE_ACCESS_KEY_ENV}" AWS_SECRET_ACCESS_KEY="$${KOPIA_RESTORE_SECRET_KEY_ENV}"`,
    ...kopiaConnectScript(KOPIA_API_USER, { create: false }),
    'echo "flui: restoring snapshot $FLUI_KOPIA_PRIMARY"',
    'kopia snapshot restore "$FLUI_KOPIA_PRIMARY" "$d" --no-progress --ignore-permission-errors >/dev/null',
    'if [ -n "${FLUI_KOPIA_SQLITE:-}" ]; then kopia snapshot restore "$FLUI_KOPIA_SQLITE" "$d" --no-progress --ignore-permission-errors >/dev/null; fi',
    'kopia repository disconnect >/dev/null 2>&1 || true',
    'sync',
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$d/.flui-restored"',
    'echo "flui: restore complete"',
  ].join('\n');
}

/** What differs per volume: where the repository is and which snapshot. */
export function kopiaRebuildRestoreEnv(
  location: KopiaS3Location,
  repositoryAppId: string,
  record: Pick<KopiaSnapshotRecord, 'snapshotId' | 'sqlite'>,
): Array<{ name: string; value: string }> {
  return [
    ...kopiaLocationEnv(location, repositoryAppId),
    { name: 'FLUI_KOPIA_PRIMARY', value: record.snapshotId },
    ...(record.sqlite?.snapshotId
      ? [{ name: 'FLUI_KOPIA_SQLITE', value: record.sqlite.snapshotId }]
      : []),
  ];
}
