import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { trimSlashes } from '../utils/destination-layout.util';
import {
  CRYPT_SUFFIX,
  CryptPasswords,
  RCLONE_CRYPT_CIPHER,
  cryptEnv,
  remoteName,
} from '../utils/rclone-crypt.util';
import { ZSTD_SUFFIX } from './db-compression.util';

/** The companion container that owns object-storage access for this engine. */
export const SHIPPER_CONTAINER = 'flui-binlog-shipper';

/**
 * Where the shipper's destination arrives, and why it is a mounted file.
 *
 * This container is on every catalog MariaDB whether or not anyone has asked
 * for backups — that is what makes enabling one a change of configuration
 * rather than a restart of the database. But a destination only exists once a
 * policy does, and environment variables are fixed for the life of a pod, so
 * reading it from the environment would have put the restart back in the one
 * place the design exists to avoid it. A Secret mounted as a file is updated
 * in place: creating the policy makes it appear and deleting it makes it
 * vanish, both without touching the database.
 *
 * Measured on k3s v1.35: about a minute in each direction, because kubelet
 * refreshes mounted Secrets on its sync loop rather than on a watch. Nothing
 * here may assume the file is there the moment the Secret is written.
 */
export const SHIPPER_SECRET_SUFFIX = '-binlog-shipper';
export const SHIPPER_CONFIG_KEY = 'config';
export const SHIPPER_CONFIG_PATH = '/etc/flui/shipper/config';
export const SHIPPER_CONFIG_POLL_MS = 5_000;
export const SHIPPER_CONFIG_WAIT_MS = 3 * 60 * 1000;

/** Written by a shipper image that can read and write through `flui_crypt`. */
export const SHIPPER_FEATURES_PATH = '/usr/local/share/flui/shipper-features';
export const SHIPPER_CRYPT_FEATURE = 'rclone-crypt';
export const RESTORE_CRYPT_ENV_PREFIX = 'FLUI_MARIADB_CRYPT_';

export interface MariadbTarget {
  kubeconfig: string;
  namespace: string;
  labelSelector: string;
  container: string;
  host: string;
  port: number;
  /** Root credential's env var inside the container — never read by Flui. */
  rootPasswordVar: string;
  user: string;
  database: string;
}

/**
 * `mariadb/<appId>/<generation>/`, and the generation is not decoration.
 *
 * A MariaDB restored onto a fresh volume numbers its binary logs from
 * `binlog.000001` again — the base backup carries no `binlog.index`, so the
 * new server has no idea what came before. Shipping that into the prefix its
 * previous life used means writing names the repository already holds with
 * different contents behind them: the upload rule ships nothing while the new
 * files are shorter, then overwrites; the contiguity check sees an unbroken
 * run of names; and the purge floor, read from the old bases, names a log the
 * new server does not have. Every one of those failures is silent.
 *
 * The same thing happens with no restore at all, the day a StatefulSet's
 * volume is lost and recreated under an active policy.
 *
 * Rows written before the generation existed have none, and keep the flat
 * layout they were written into — the only reading that finds their objects.
 */
export function artifactObjectPrefix(
  appId: string,
  generation?: string,
): string {
  return generation ? `mariadb/${appId}/${generation}/` : `mariadb/${appId}/`;
}

/**
 * Ordered and readable, so a person listing the bucket can see which life of
 * the database they are looking at.
 */
export function mintGeneration(): string {
  return `g${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
}

/**
 * One base backup's own objects — never the binary logs, which are shared by
 * every base in the repository and are pruned against the oldest surviving
 * one, not against any single artifact.
 */
export function artifactObjectKeys(
  appId: string,
  engineRef: string,
  generation?: string,
): string[] {
  const base = `${artifactObjectPrefix(appId, generation)}base/${engineRef}`;
  return [
    `${base}/binlog_info${CRYPT_SUFFIX}`,
    `${base}/binlog_info`,
    `${base}/base.mbstream${ZSTD_SUFFIX}${CRYPT_SUFFIX}`,
    `${base}/base.mbstream${ZSTD_SUFFIX}`,
    `${base}/base.mbstream${CRYPT_SUFFIX}`,
    `${base}/base.mbstream`,
  ];
}

/**
 * The source's own user and database.
 *
 * Not cosmetic: the official entrypoint skips initialisation on a populated
 * data directory but still acts on `MARIADB_DATABASE`, and naming one the
 * recovered data does not hold makes it exit with `Unknown database` —
 * proven against 11.3.2, where the container then crash-loops.
 */
export function identityEnv(identities: {
  user: string;
  database: string;
}): Record<string, string> {
  return {
    MARIADB_USER: identities.user,
    MARIADB_DATABASE: identities.database,
  };
}

/**
 * `--stop-datetime` takes no timezone suffix and is read in the server's own
 * zone. The restore container is pinned to UTC and given UTC, because any
 * other pairing silently shifts the instant being recovered to.
 */
function toUtcTarget(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Environment a fresh install boots in restore mode with.
 *
 * Every name carries the engine's prefix so that the one-shot values can be
 * stripped again as a group once the data is down — a restore's S3
 * credentials must not outlive the boot that needed them.
 *
 * The object-storage settings are passed as fields rather than as an rclone
 * remote: `restore.sh` composes the remote itself, so the credentials never
 * appear under a name the strip step does not know to remove.
 *
 * Takes the destination's secrets already decrypted, so this stays a pure
 * mapping and the caller keeps sole ownership of the encryption service.
 */
export interface RestoreEnvTarget {
  recoveryTargetTime?: Date | null;
  restoreSet?: string | null;
  generation?: string | null;
  crypt?: CryptPasswords;
}

export function buildRestoreEnv(
  sourceAppId: string,
  dest: Pick<
    BackupDestinationEntity,
    'endpoint' | 'bucket' | 'region' | 'forcePathStyle' | 'pathPrefix'
  >,
  keys: { accessKey: string; secretKey: string },
  target?: RestoreEnvTarget,
): Record<string, string> {
  const { recoveryTargetTime, restoreSet, generation, crypt } = target ?? {};
  const prefix = trimSlashes(dest.pathPrefix);
  const env: Record<string, string> = {
    FLUI_MARIADB_RESTORE: '1',
    FLUI_MARIADB_S3_ENDPOINT: dest.endpoint,
    FLUI_MARIADB_S3_BUCKET: dest.bucket,
    FLUI_MARIADB_S3_REGION: dest.region || 'auto',
    FLUI_MARIADB_S3_KEY: keys.accessKey,
    FLUI_MARIADB_S3_KEY_SECRET: keys.secretKey,
    FLUI_MARIADB_S3_FORCE_PATH_STYLE: dest.forcePathStyle ? 'true' : 'false',
    FLUI_MARIADB_S3_PATH: `${prefix ? prefix + '/' : ''}${artifactObjectPrefix(sourceAppId, generation ?? undefined)}`,
    ...(crypt ? cryptEnv(crypt, RESTORE_CRYPT_ENV_PREFIX) : {}),
  };
  // A time and a label are alternatives, and the time wins: asking for an
  // instant means the logs are replayed up to it, while a label alone means
  // that base as it stood, with nothing replayed onto it.
  if (recoveryTargetTime) {
    env.FLUI_MARIADB_TARGET_TIME = toUtcTarget(recoveryTargetTime);
  } else if (restoreSet) {
    env.FLUI_MARIADB_BASE_LABEL = restoreSet;
  }
  return env;
}

/**
 * The shipper's whole configuration, as the file `ship.sh` and every exec'd
 * script source. With `crypt`, the repository remote is `flui_crypt:` and the
 * two derived secrets travel beside the storage credentials in the same
 * Secret; `FLUI_ENCRYPTION` is what a base backup reports back as used.
 */
export function renderShipperConfig(args: {
  appId: string;
  dest: Pick<
    BackupDestinationEntity,
    'bucket' | 'pathPrefix' | 'endpoint' | 'region' | 'forcePathStyle'
  >;
  repositoryPrefix: string;
  accessKey: string;
  secretKey: string;
  crypt?: CryptPasswords;
  compression?: 'zstd';
}): string {
  const prefix = trimSlashes(args.dest.pathPrefix);
  const remote = `${remoteName(!!args.crypt)}:${args.dest.bucket}/${prefix ? prefix + '/' : ''}${args.repositoryPrefix.replace(/\/$/, '')}`;
  const q = (v: string) => JSON.stringify(v);
  return [
    `export FLUI_S3_REMOTE=${q(remote)}`,
    `export FLUI_APP_ID=${q(args.appId)}`,
    'export RCLONE_CONFIG_FLUI_TYPE=s3',
    'export RCLONE_CONFIG_FLUI_PROVIDER=Other',
    `export RCLONE_CONFIG_FLUI_ACCESS_KEY_ID=${q(args.accessKey)}`,
    `export RCLONE_CONFIG_FLUI_SECRET_ACCESS_KEY=${q(args.secretKey)}`,
    `export RCLONE_CONFIG_FLUI_ENDPOINT=${q(args.dest.endpoint)}`,
    `export RCLONE_CONFIG_FLUI_REGION=${q(args.dest.region || 'auto')}`,
    `export RCLONE_CONFIG_FLUI_FORCE_PATH_STYLE=${args.dest.forcePathStyle ? 'true' : 'false'}`,
    ...(args.crypt
      ? [
          `export FLUI_ENCRYPTION=${q(RCLONE_CRYPT_CIPHER)}`,
          ...Object.entries(cryptEnv(args.crypt)).map(
            ([k, v]) => `export ${k}=${q(v)}`,
          ),
        ]
      : []),
    ...(args.compression
      ? [`export FLUI_COMPRESSION=${q(args.compression)}`]
      : []),
    `export FLUI_CONFIG_VERSION=${args.crypt ? 2 : 1}`,
    'export FLUI_CONFIG_COMPLETE=1',
    '',
  ].join('\n');
}
