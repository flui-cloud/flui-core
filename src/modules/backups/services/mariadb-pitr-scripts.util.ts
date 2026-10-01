import {
  ArtifactCompression,
  SHIPPER_ZSTD_LEVEL,
  ZSTD_SUFFIX,
} from './db-compression.util';
import { RESTORE_POINT_MARKER } from '../utils/restore-point.util';
import {
  SHIPPER_CONFIG_KEY,
  SHIPPER_CONFIG_PATH,
  SHIPPER_FEATURES_PATH,
} from './mariadb-pitr.util';
import { cryptSetupScript } from '../utils/rclone-crypt.util';

export interface ShippingState {
  destinationId: string;
  generation?: string;
  encrypted: boolean;
  compressed: boolean;
  lastBaseEncrypted?: boolean;
  lastBaseCompression?: ArtifactCompression;
}

export interface RepositoryEntry {
  at: string;
  path: string;
}

export interface RepositoryListing {
  bases: RepositoryEntry[];
  logs: RepositoryEntry[];
}

/** How far the repository's newest binary log may trail the server's before a run stops trusting the stream. */
const SHIPPED_EDGE_TOLERANCE = 2;

export const NO_SHIPPER_FOR_BASE =
  'This MariaDB has no backup shipper alongside it, so it cannot take a ' +
  'base backup. Its binary logs are still being written and are still ' +
  'being retained, so nothing has been lost yet — but nothing is ' +
  'carrying them off the cluster either.';

export const NO_SHIPPER_FOR_POLICY =
  'This MariaDB has no backup shipper alongside it, so nothing would ' +
  'carry its binary logs off the cluster. MariaDB cannot hand a ' +
  'finished log to a command of its own the way Postgres does, so the ' +
  'shipper is not optional: enabling a policy without one would record ' +
  'protection that does not exist, and stop the database purging its ' +
  'own logs while nothing collected them. A database gets its shipper ' +
  'when it is installed from a catalog that provides one.';

export const DATABASE_NOT_RUNNING =
  'This database is not running, so continuous backup cannot be set ' +
  'up on it. Start it and try again.';

export const LOG_BIN_OFF =
  'This MariaDB was created before Flui enabled binary logging, and ' +
  '`log_bin` cannot be turned on while the server runs. Redeploy the ' +
  'application to pick up the current configuration — it restarts the ' +
  'database — and then enable continuous backup.';

export const SHIPPER_CONFIG_LATE =
  'The backup destination has not reached the shipper yet. Kubernetes ' +
  'delivers a mounted secret on its sync loop, usually within a ' +
  'minute; nothing is wrong with the database, and the next ' +
  'scheduled run will take the first base backup.';

export const BASE_INCOMPLETE =
  'The base backup did not complete, so no restore point was created. ' +
  "Check the shipper container's logs.";

export const TOOLING_SCRIPT =
  'for t in mariadb-backup mariadb-binlog mariadb; do ' +
  'command -v "$t" >/dev/null 2>&1 || { echo "MISSING:$t"; exit 0; }; ' +
  'done; echo OK';

export function missingToolMessage(tools: string): string | null {
  const missing = /MISSING:(\S+)/.exec(tools);
  if (!missing) return null;
  return (
    `This database cannot do continuous backup: its image does not ship ` +
    `${missing[1]}. Continuous backup needs a MariaDB installed from the ` +
    'Flui catalog. For a database running from another image, take ' +
    'backups of its volume instead.'
  );
}

/**
 * Three settings, all dynamic, all reversed by {@link releaseServerScript}:
 *
 * `binlog_format = ROW` because statement replay can diverge on
 * non-deterministic statements, and that failure looks like a successful
 * restore holding subtly wrong data.
 *
 * `sync_binlog = 1` because the default lets a host crash lose committed
 * transactions from the binary log that InnoDB has already kept — the
 * recovery window would then be missing writes the database itself still has.
 *
 * `binlog_expire_logs_seconds = 0` because the server's own ten-day purge
 * knows nothing about what has been shipped. With it at zero the disk fills
 * if shipping stalls, which is loud; with it left alone the recovery window
 * silently develops a hole that is discovered during a restore.
 */
export function prepareServerScript(client: string): string {
  return [
    'set -e',
    `${client} -e "SET GLOBAL binlog_format = 'ROW'"`,
    `${client} -e "SET GLOBAL sync_binlog = 1"`,
    `${client} -e "SET GLOBAL binlog_expire_logs_seconds = 0"`,
    `${client} -e "FLUSH BINARY LOGS"`,
  ].join('\n');
}

export function releaseServerScript(client: string): string {
  return [
    `${client} -e "SET GLOBAL binlog_expire_logs_seconds = 864000" || true`,
    `${client} -e "SET GLOBAL sync_binlog = 0" || true`,
  ].join('\n');
}

/**
 * The shipper's destination, credentials included, as one file.
 *
 * The whole destination travels in the Secret rather than in the pod spec:
 * `ship.sh` sources the file, so the exported rclone settings reach the
 * child process, and no object-storage credential ever appears in a manifest
 * or in the application's own environment.
 *
 * `FLUI_CONFIG_COMPLETE` is written last and checked by the reader. kubelet
 * swaps the whole directory atomically, so a half-written file should be
 * impossible — which is exactly why the sentinel is cheap to keep and would
 * have been expensive to assume.
 */
export function shipperSecretManifest(args: {
  name: string;
  namespace: string;
  appId: string;
  config: string;
}): string {
  return [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${args.name}`,
    `  namespace: ${args.namespace}`,
    '  labels:',
    // Labelled so the application's teardown sweep takes it with the rest.
    `    flui-app-id: ${args.appId}`,
    '  annotations: {}',
    'type: Opaque',
    'data:',
    `  ${SHIPPER_CONFIG_KEY}: ${Buffer.from(args.config, 'utf-8').toString('base64')}`,
    '',
  ].join('\n');
}

export const SHIPPER_CONFIG_PROBE_SCRIPT =
  `if test -r ${SHIPPER_CONFIG_PATH}; then ` +
  `grep -q '^export FLUI_ENCRYPTION=' ${SHIPPER_CONFIG_PATH} && echo FLUI_CONFIG_CRYPT || echo FLUI_CONFIG_PLAIN; ` +
  `grep -q '^export FLUI_COMPRESSION=' ${SHIPPER_CONFIG_PATH} && echo FLUI_CONFIG_ZSTD || echo FLUI_CONFIG_RAW; ` +
  'else echo FLUI_CONFIG_ABSENT; fi';

export function shipperConfigMatches(
  seen: string,
  state: ShippingState | undefined,
): boolean {
  const cipher = state?.encrypted ? 'FLUI_CONFIG_CRYPT' : 'FLUI_CONFIG_PLAIN';
  return (
    seen.includes(cipher) &&
    seen.includes('FLUI_CONFIG_ZSTD') === !!state?.compressed
  );
}

export const SHIPPER_FEATURES_SCRIPT = `cat ${SHIPPER_FEATURES_PATH} 2>/dev/null; echo FLUI_FEATURES_READ`;

export function parseShipperFeatures(out: string): Set<string> | null {
  if (!out.includes('FLUI_FEATURES_READ')) return null;
  return new Set(
    out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

export function baseLabel(now: Date): string {
  return `base-${now.toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
}

/**
 * Run in the shipper container rather than the database's own, and that is
 * the point: the official MariaDB image has no way to talk to S3 — no rclone,
 * no curl, not even wget — so a base backup taken there would have to land on
 * the data volume first, doubling the space the database needs at the exact
 * moment it is being protected. The shipper mounts the same volume and has
 * both tools, so the backup never touches disk twice.
 *
 * The position it ends at is captured with it. Without that, the binary logs
 * are a pile of files with no declared point to start replaying from.
 */
export function baseBackupScript(
  label: string,
  host: string,
  port: number,
): string {
  return [
    'set -euo pipefail',
    '. /etc/flui/shipper/config',
    cryptSetupScript(),
    `LABEL="${label}"`,
    // Both halves live under one per-application prefix, so a single
    // `objectKeyPrefix` on the artifact location covers the base and the
    // logs that bring it forward — and deleting one deletes the pair.
    'DEST="$FLUI_S3_REMOTE/base/$LABEL"',
    // Compressed only by an image that says it can, and only when the
    // configuration asks: the base reports what it actually did.
    'COMP=none',
    'if [ "${FLUI_COMPRESSION:-}" = "zstd" ] && command -v zstd >/dev/null 2>&1; then COMP=zstd; fi',
    // `--stream` writes to stdout, so nothing lands on the data volume.
    'BACKUP_CMD="mariadb-backup --backup --stream=mbstream ' +
      `--host=${host} --port=${port} ` +
      '--user=root"',
    'if [ "$COMP" = "zstd" ]; then',
    `  $BACKUP_CMD --password="$MARIADB_ROOT_PASSWORD" 2>/tmp/backup.log | zstd -q -${SHIPPER_ZSTD_LEVEL} -T2 -c | rclone rcat "$DEST/base.mbstream${ZSTD_SUFFIX}" --s3-no-check-bucket`,
    'else',
    '  $BACKUP_CMD --password="$MARIADB_ROOT_PASSWORD" 2>/tmp/backup.log | rclone rcat "$DEST/base.mbstream" --s3-no-check-bucket',
    'fi',
    // The position the logs have to be replayed from. It travels INSIDE
    // the base as `mariadb_backup_binlog_info`, which is what a restore
    // reads — a sibling object could drift from the base it describes.
    // This copy exists only so the shipper can learn its purge floor
    // without pulling a multi-gigabyte stream to read three fields, and it
    // is written in the same tab-separated format as the in-base file so
    // there is one format to parse and not two.
    'POS=$(grep -oE "filename .([^\x27]+)., position .([0-9]+)., GTID of the last change .([^\x27]*)." /tmp/backup.log | tail -1)',
    'FILE=$(echo "$POS" | sed -E "s/.*filename \x27([^\x27]+)\x27.*/\\1/")',
    'POSN=$(echo "$POS" | sed -E "s/.*position \x27([0-9]+)\x27.*/\\1/")',
    'GTID=$(echo "$POS" | sed -E "s/.*change \x27([^\x27]*)\x27.*/\\1/")',
    String.raw`printf "%s\t%s\t%s\n" "$FILE" "$POSN" "$GTID" | rclone rcat "$DEST/binlog_info" --s3-no-check-bucket`,
    'echo "FLUI_BASE_OK=$LABEL POS=$FILE:$POSN CIPHER=${FLUI_ENCRYPTION:-none} COMPRESSION=$COMP LOGS=$COMP"',
  ].join('\n');
}

export function markRestorePointScript(client: string): string {
  return [
    'set -e',
    `AT="$(${client} -e "SELECT FLOOR(UNIX_TIMESTAMP(NOW(3)) * 1000)")"`,
    `POS="$(${client} -e "SHOW MASTER STATUS" | awk 'NR==1{print $1":"$2}')"`,
    `${client} -e "FLUSH BINARY LOGS"`,
    `echo "${RESTORE_POINT_MARKER}$AT $POS"`,
  ].join('\n');
}

export function shippedEdgeScript(host: string, port: number): string {
  return [
    '. /etc/flui/shipper/config 2>/dev/null || exit 0',
    cryptSetupScript({ onFailure: 'exit 0' }),
    `echo "SERVER=$(mariadb -h ${host} -P ${port} -uroot -p"$MARIADB_ROOT_PASSWORD" -N -B -e 'SHOW BINARY LOGS' 2>/dev/null | tail -1 | awk '{print $1}')"`,
    String.raw`echo "SHIPPED=$(rclone lsf "$FLUI_S3_REMOTE/binlog/" 2>/dev/null | grep -E '^binlog\.[0-9]+(\.zst)?$' | sed -E 's/\.zst$//' | sort | tail -1)"`,
  ].join('\n');
}

export function shippedEdgeWithinTolerance(out: string): boolean {
  const num = (name?: string) => Number(/\.(\d+)$/.exec(name ?? '')?.[1]);
  const server = num(/SERVER=(\S+)/.exec(out)?.[1]);
  const shipped = num(/SHIPPED=(\S+)/.exec(out)?.[1]);
  if (!Number.isFinite(server) || !Number.isFinite(shipped)) return false;
  return shipped >= server - SHIPPED_EDGE_TOLERANCE;
}

export function listRepositoryScript(): string {
  return [
    'export TZ=UTC',
    '. /etc/flui/shipper/config 2>/dev/null || exit 0',
    cryptSetupScript({ onFailure: 'exit 0' }),
    // Times, not names. The window a person is shown has to be made of
    // moments: a base label truncated to a column width reads like a date
    // and is not one, and `Date.parse` on it yields NaN, so every check
    // written against the window silently stops being a check.
    'echo "BASES=$(rclone lsf --format tp -R "$FLUI_S3_REMOTE/base/" 2>/dev/null | grep "/binlog_info$" | sort | tr "\n" " ")"',
    'echo "LOGS=$(rclone lsf --format tp "$FLUI_S3_REMOTE/binlog/" 2>/dev/null | sort -t";" -k2 | tr "\n" " ")"',
  ].join('\n');
}

/** Each entry is `YYYY-MM-DD HH:MM:SS;path`. */
function parseListingLine(line: string | undefined): RepositoryEntry[] {
  return (line ?? '')
    .trim()
    .split(/\s(?=\d{4}-)/)
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const [when, ...rest] = e.split(';');
      return { at: when, path: rest.join(';') };
    });
}

export function parseRepositoryListing(out: string): RepositoryListing {
  return {
    bases: parseListingLine(/BASES=(.*)/.exec(out)?.[1]),
    logs: parseListingLine(/LOGS=(.*)/.exec(out)?.[1]),
  };
}

export function utcIso(when: string | undefined): string | null {
  return when ? `${when.trim().replace(' ', 'T')}Z` : null;
}

export function repositoryWindow({ bases, logs }: RepositoryListing): {
  latestLabel: string | null;
  oldestRecoverable: string | null;
  newestRecoverable: string | null;
  backupCount: number;
} {
  return {
    backupCount: bases.length,
    latestLabel: bases.at(-1)?.path.replace(/\/binlog_info$/, '') ?? null,
    // A base with no logs after it is a single point, not a window; a log
    // with no base before it cannot be replayed onto anything.
    oldestRecoverable: bases.length && logs.length ? utcIso(bases[0].at) : null,
    newestRecoverable:
      bases.length && logs.length ? utcIso(logs.at(-1)?.at) : null,
  };
}

/** When the next base is due, or null when it is due now. */
export function nextBaseDue(
  lastBaseAt: string,
  everyDays: number,
  now: number,
): Date | null {
  const dueAt = new Date(
    Date.parse(lastBaseAt) + Math.max(1, everyDays) * 86_400_000,
  );
  if (!Number.isFinite(dueAt.getTime()) || now >= dueAt.getTime()) {
    return null;
  }
  return dueAt;
}
