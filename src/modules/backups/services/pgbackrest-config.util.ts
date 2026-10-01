import { ApplicationEntity } from '../../applications/entities/application.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { PG_COMPRESS_LEVEL, PG_COMPRESS_TYPE } from './db-compression.util';
import {
  RESTORE_POINT_MARKER,
  restorePointLabel,
} from '../utils/restore-point.util';
import {
  PG_REPO_CIPHER,
  REPO_PATH_MARKER,
  assertConfigValue,
  repoPathIn,
} from './pgbackrest-repo.util';

export const DATABASE_NOT_RUNNING =
  'This database is not running, so continuous backup cannot be set ' +
  'up on it. Start it and try again.';

export const NO_PGBACKREST =
  'This database cannot do continuous backup: its image does not ship ' +
  'pgBackRest. Continuous backup (WAL shipping and point-in-time ' +
  'recovery) needs a database installed from the Flui catalog. For a ' +
  'database running from another image, take backups of its volume ' +
  'instead.';

const DEFAULT_PGDATA = '/var/lib/postgresql/data/pgdata';
export const PGBACKREST_STANZA = 'main';
const LAST_ARCHIVED_MARKER = 'FLUI_LAST_ARCHIVED=';
// WAL replay keeps running well past the pod turning Ready on big restores.
export const RESTORE_RECONCILE_POLL_INTERVAL_MS = 5_000;
export const RESTORE_RECONCILE_TIMEOUT_MS = 30 * 60 * 1000;
export const RECOVERY_ENDED_BEFORE_TARGET =
  /recovery ended before configured recovery target was reached/;

/**
 * The longest a quiet database holds committed changes before shipping them.
 *
 * Every forced switch archives a whole 16 MB segment, zero-padded past the
 * last write. Compressed that padding is small (measured on PG 17: ~16.7 KB
 * per segment with gzip, ~1 KB with zstd) but it is paid once per interval
 * with any write at all, together with an S3 PUT and a listing. At 60 s a
 * trickle of writes meant 1440 segments a day; 300 s is 288, for an RPO of
 * five minutes on the loss of the volume itself.
 */
export const DEFAULT_ARCHIVE_TIMEOUT_SECONDS = 300;
export const MIN_ARCHIVE_TIMEOUT_SECONDS = 60;
export const MAX_ARCHIVE_TIMEOUT_SECONDS = 3600;

export function archiveTimeoutSeconds(requested?: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return DEFAULT_ARCHIVE_TIMEOUT_SECONDS;
  }
  return Math.min(
    MAX_ARCHIVE_TIMEOUT_SECONDS,
    Math.max(MIN_ARCHIVE_TIMEOUT_SECONDS, Math.round(requested)),
  );
}

export interface PgBackrestTarget {
  kubeconfig: string;
  namespace: string;
  labelSelector: string;
  container: string;
  pgdata: string;
  pgUser: string;
  pgDb: string;
  confPath: string;
}

export interface PgBackupInfo {
  /** Newest backup label, or null when the repo has no backups yet. */
  latestLabel: string | null;
  /**
   * Recoverable window: from the end of the oldest base to the last WAL
   * segment that reached the repository (the last base's end when the server
   * cannot say).
   */
  oldestRecoverable: string | null;
  newestRecoverable: string | null;
  /** Completion time of the most recent FULL backup (drives full cadence). */
  lastFullAt: string | null;
  backupCount: number;
  /** What the newest backup occupies in the repository, compressed. */
  latestSizeBytes?: number | null;
}

interface PgBackrestInfoBackup {
  label?: string;
  type?: string;
  timestamp?: { start?: number; stop?: number };
  info?: { repository?: { size?: number; delta?: number } };
}

function pvcRoot(pgdata: string): string {
  const idx = pgdata.lastIndexOf('/');
  return idx > 0 ? pgdata.slice(0, idx) : '/var/lib/postgresql/data';
}

export function pgbackrestTargetFor(
  app: ApplicationEntity,
  kubeconfig: string,
): PgBackrestTarget {
  const envValue = (name: string) =>
    app.env?.find((e) => e.name === name)?.value;
  const pgdata = envValue('PGDATA') ?? DEFAULT_PGDATA;
  const pgUser = envValue('POSTGRES_USER') ?? 'postgres';
  const pgDb = envValue('POSTGRES_DB') ?? pgUser;
  return {
    kubeconfig,
    namespace: app.k8sNamespace,
    labelSelector: `flui-app-id=${app.id}`,
    container: app.slug,
    pgdata,
    pgUser,
    pgDb,
    confPath: `${pvcRoot(pgdata)}/pgbackrest.conf`,
  };
}

export function s3EndpointHost(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, '');
}

export function buildPgbackrestConf(args: {
  dest: BackupDestinationEntity;
  target: PgBackrestTarget;
  repositoryPrefix: string;
  retentionFull: number;
  cipherPass: string;
  accessKey: string;
  secretKey: string;
}): string {
  const { dest, target } = args;
  const uriStyle = dest.forcePathStyle ? 'path' : 'host';
  return [
    '[global]',
    'repo1-type=s3',
    // The flui-postgres image ships ca-certificates so the S3 endpoint cert
    // is verified (no verify-tls=n).
    'repo1-storage-ca-file=/etc/ssl/certs/ca-certificates.crt',
    `repo1-s3-endpoint=${s3EndpointHost(dest.endpoint)}`,
    `repo1-s3-bucket=${dest.bucket}`,
    `repo1-s3-region=${dest.region}`,
    `repo1-s3-key=${args.accessKey}`,
    `repo1-s3-key-secret=${args.secretKey}`,
    `repo1-s3-uri-style=${uriStyle}`,
    `repo1-path=${repoPathIn(dest.pathPrefix, args.repositoryPrefix)}`,
    `repo1-cipher-type=${PG_REPO_CIPHER}`,
    `repo1-cipher-pass=${assertConfigValue('The destination passphrase', args.cipherPass)}`,
    `repo1-retention-full=${args.retentionFull}`,
    'repo1-retention-archive-type=full',
    // Bundle many small relation files into few S3 objects — without this a
    // fresh cluster's ~1000+ files upload one PUT at a time (minutes → ~1min).
    'repo1-bundle=y',
    // Needs repo1-bundle and pgBackRest >= 2.46. An incremental then stores
    // the changed blocks of a file instead of the whole file.
    'repo1-block=y',
    `compress-type=${PG_COMPRESS_TYPE}`,
    `compress-level=${PG_COMPRESS_LEVEL}`,
    'process-max=4',
    'start-fast=y',
    'log-level-console=info',
    '',
    `[${PGBACKREST_STANZA}]`,
    `pg1-path=${target.pgdata}`,
    // pgBackRest connects to Postgres to verify a primary; the maintenance
    // role/db is the app's own user, not the default 'postgres'.
    `pg1-user=${target.pgUser}`,
    `pg1-database=${target.pgDb}`,
    '',
  ].join('\n');
}

const pgbackrest = (target: PgBackrestTarget): string =>
  `gosu postgres pgbackrest --config=${target.confPath} --stanza=${PGBACKREST_STANZA}`;

const psqlAdmin = (target: PgBackrestTarget): string =>
  `gosu postgres psql -U ${target.pgUser} -d ${target.pgDb} -v ON_ERROR_STOP=1 -c`;

export const NOT_IN_RECOVERY_SCRIPT = `gosu postgres psql -U "$POSTGRES_USER" -d postgres -tAc 'SELECT NOT pg_is_in_recovery()' 2>/dev/null || true`;

export const RESET_SUPERUSER_PASSWORD_SCRIPT = String.raw`printf '%s\n' "ALTER ROLE \"$POSTGRES_USER\" WITH PASSWORD :'pw';" | gosu postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -v pw="$POSTGRES_PASSWORD"`;

export const PGBACKREST_PRESENT_SCRIPT =
  'command -v pgbackrest >/dev/null 2>&1 && echo yes || echo no';

export const PGBACKREST_VERSION_COMMAND = String.raw`pgbackrest version | awk "{print \$2}"`;

export function serverVersionCommand(target: PgBackrestTarget): string {
  return `gosu postgres psql -U ${target.pgUser} -d ${target.pgDb} -tAc "SHOW server_version"`;
}

export function infoJsonCommand(target: PgBackrestTarget): string {
  return `${pgbackrest(target)} info --output=json`;
}

export function manifestCompressionCommand(
  target: PgBackrestTarget,
  label: string,
): string {
  return `${pgbackrest(target)} repo-get backup/${PGBACKREST_STANZA}/${label}/backup.manifest | grep -E '^option-compress-(type|level)='`;
}

export function enableScript(
  target: PgBackrestTarget,
  conf: string,
  archiveTimeout: number,
): string {
  const confB64 = Buffer.from(conf, 'utf-8').toString('base64');
  const archiveCommand = `pgbackrest --config=${target.confPath} --stanza=${PGBACKREST_STANZA} archive-push %p`;
  return [
    'set -e',
    'umask 077',
    `echo ${confB64} | base64 -d > ${target.confPath}`,
    `chown postgres:postgres ${target.confPath}`,
    `chmod 600 ${target.confPath}`,
    `${pgbackrest(target)} --log-level-console=info stanza-create`,
    `${psqlAdmin(target)} "ALTER SYSTEM SET archive_command = '${archiveCommand}';"`,
    // Without archive_timeout WAL only ships on 16MB segment switches — on a
    // quiet database the recoverable edge can lag hours behind "now".
    `${psqlAdmin(target)} "ALTER SYSTEM SET archive_timeout = '${archiveTimeout}s';"`,
    `${psqlAdmin(target)} "SELECT pg_reload_conf();"`,
  ].join('\n');
}

export function disableScript(target: PgBackrestTarget): string {
  return [
    'set -e',
    `${psqlAdmin(target)} "ALTER SYSTEM SET archive_command = '/bin/true';"`,
    `${psqlAdmin(target)} "ALTER SYSTEM RESET archive_timeout;"`,
    `${psqlAdmin(target)} "SELECT pg_reload_conf();"`,
  ].join('\n');
}

export function baseBackupScript(
  target: PgBackrestTarget,
  type: 'full' | 'incr' | 'diff',
): string {
  return [
    'set -e',
    `${pgbackrest(target)} --type=${type} --log-level-console=info backup`,
  ].join('\n');
}

export function markRestorePointScript(
  target: PgBackrestTarget,
  label: string,
): string {
  const psql = `gosu postgres psql -U ${target.pgUser} -d ${target.pgDb} -v ON_ERROR_STOP=1 -tA`;
  return [
    'set -e',
    `MARK="$(${psql} -F ' ' -c "SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint, pg_create_restore_point('${restorePointLabel(label)}')")"`,
    `${psql} -c "SELECT pg_switch_wal()" >/dev/null`,
    `echo "${RESTORE_POINT_MARKER}$MARK"`,
  ].join('\n');
}

export function infoScript(target: PgBackrestTarget): string {
  return [
    infoJsonCommand(target),
    `echo "${REPO_PATH_MARKER}$(sed -n 's/^repo1-path=//p' ${target.confPath})"`,
    `echo "${LAST_ARCHIVED_MARKER}$(gosu postgres psql -U ${target.pgUser} -d ${target.pgDb} -tAc "SELECT CASE WHEN current_setting('archive_command') LIKE '%pgbackrest%' THEN floor(extract(epoch from last_archived_time)) END FROM pg_stat_archiver" 2>/dev/null)"`,
  ].join('\n');
}

export function pgRestoreEnv(args: {
  dest: BackupDestinationEntity;
  repository: { objectKeyPrefix: string; encrypted: boolean };
  accessKey: string;
  secretKey: string;
  passphrase: string | null | undefined;
  recoveryTargetTime?: Date | null;
  restoreSet?: string | null;
}): Record<string, string> {
  const { dest, repository } = args;
  const env: Record<string, string> = {
    FLUI_PG_RESTORE: '1',
    FLUI_PG_S3_ENDPOINT: s3EndpointHost(dest.endpoint),
    FLUI_PG_S3_BUCKET: dest.bucket,
    FLUI_PG_S3_REGION: dest.region,
    FLUI_PG_S3_KEY: args.accessKey,
    FLUI_PG_S3_KEY_SECRET: args.secretKey,
    FLUI_PG_S3_URI_STYLE: dest.forcePathStyle ? 'path' : 'host',
    FLUI_PG_S3_PATH: repoPathIn(dest.pathPrefix, repository.objectKeyPrefix),
  };
  if (repository.encrypted) {
    if (!args.passphrase) {
      throw new Error(
        'This backup is encrypted, and its destination no longer holds the passphrase it was encrypted with',
      );
    }
    env.FLUI_PG_CIPHER_PASS = assertConfigValue(
      'The destination passphrase',
      args.passphrase,
    );
  }
  if (args.recoveryTargetTime) {
    env.FLUI_PG_RESTORE_TARGET = toPgTimeTarget(args.recoveryTargetTime);
  } else if (args.restoreSet) {
    env.FLUI_PG_RESTORE_SET = args.restoreSet;
  }
  return env;
}

/** pgBackRest --target format: 'YYYY-MM-DD HH:MM:SS+00' (UTC). */
export function toPgTimeTarget(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ') + '+00';
}

const EMPTY_INFO: PgBackupInfo = {
  latestLabel: null,
  oldestRecoverable: null,
  newestRecoverable: null,
  lastFullAt: null,
  backupCount: 0,
};

export function parsePgbackrestInfo(json: string): PgBackupInfo {
  let stanzas: unknown;
  try {
    stanzas = JSON.parse(json);
  } catch {
    return { ...EMPTY_INFO };
  }
  const stanza = Array.isArray(stanzas)
    ? (stanzas.find((s: { name?: string }) => s?.name === PGBACKREST_STANZA) as
        | { backup?: PgBackrestInfoBackup[] }
        | undefined)
    : undefined;
  const backups = stanza?.backup ?? [];
  if (backups.length === 0) return { ...EMPTY_INFO };
  const toIso = (epoch?: number): string | null =>
    typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
  const first = backups[0];
  const last = backups.at(-1);
  let lastFull: PgBackrestInfoBackup | undefined;
  for (let i = backups.length - 1; i >= 0; i--) {
    if (backups[i].type === 'full') {
      lastFull = backups[i];
      break;
    }
  }
  return {
    latestLabel: last.label ?? null,
    // Consistency is only reached at the END of the oldest base backup —
    // targets inside its start..stop window are not recoverable.
    oldestRecoverable: toIso(first.timestamp?.stop),
    newestRecoverable: toIso(last.timestamp?.stop),
    lastFullAt: toIso(lastFull?.timestamp?.stop),
    backupCount: backups.length,
    latestSizeBytes:
      last.info?.repository?.delta ?? last.info?.repository?.size ?? null,
  };
}

/**
 * The pgBackRest error a failed restore-bootstrap printed. An encrypted
 * repository read without its key fails on the first file it opens, and only
 * an image older than encrypted backups leaves the key out.
 */
export function restoreFailureFrom(logs: string): string | null {
  if (/FormatError\] unable to load info file .*\/encrypted\//.test(logs)) {
    return 'This backup is encrypted and the PostgreSQL image the restore ran could not open it: update the flui-postgres image to a release that restores encrypted backups, then restore again.';
  }
  const error = /ERROR: \[\d+\]: ([^\n]+)/.exec(logs);
  return error ? `pgBackRest stopped the restore: ${error[1].trim()}` : null;
}

export function withArchivedEdge(
  info: PgBackupInfo,
  execOutput: string,
): PgBackupInfo {
  const epoch = Number(
    new RegExp(String.raw`${LAST_ARCHIVED_MARKER}(\d+)`).exec(execOutput)?.[1],
  );
  if (!info.backupCount || !Number.isFinite(epoch) || epoch <= 0) return info;
  const archived = new Date(epoch * 1000);
  const newest = info.newestRecoverable
    ? new Date(info.newestRecoverable)
    : null;
  return newest && newest >= archived
    ? info
    : { ...info, newestRecoverable: archived.toISOString() };
}
