import { hkdfSync } from 'node:crypto';
import { kopiaBucketPrefix } from './destination-layout.util';

/**
 * Volume backups are kopia snapshots, one repository per (destination,
 * application).
 *
 * The same pinned build runs in the snapshot Job and inside the API, which
 * opens a repository read-only to list a snapshot's files. A repository format
 * written by one version and read by another is the one mismatch worth ruling
 * out, so both come from this image.
 */
export const KOPIA_VERSION = '0.23.1';
export const KOPIA_IMAGE =
  'kopia/kopia:0.23.1@sha256:89fd95ee2942880ca00eae964266958a394421ddbdf69bca62e38afc55f5900e';

export const KOPIA_ENGINE = 'kopia';
/** `manifestSummary.sink` of a kopia snapshot, beside `s3-archive` and `pvc-clone`. */
export const KOPIA_SINK = 'kopia';
export const KOPIA_ENCRYPTION = 'AES256-GCM-HMAC-SHA256';
export const KOPIA_SPLITTER = 'DYNAMIC-1M-BUZHASH';
export const KOPIA_COMPRESSION = 'zstd-fastest';
/** What `manifestSummary.repository.cipher` records, so every reader says "encrypted". */
export const KOPIA_CIPHER = 'kopia-aes256-gcm-hmac-sha256';
/** Ad-hoc snapshots are pinned: only a person removes what a person took. */
export const KOPIA_MANUAL_PIN = 'flui-manual';

/**
 * Who writes, and who only reads.
 *
 * Every Job connects as the same user@host, which is also the repository's
 * maintenance owner: kopia refuses maintenance from anyone else, and garbage
 * is only collected when maintenance runs, so a second identity writing would
 * leave data nothing ever frees. The API connects as another user so it can
 * never become the owner by accident and run maintenance in its own process.
 */
export const KOPIA_JOB_USER = 'flui';
export const KOPIA_API_USER = 'flui-api';

export function kopiaHostname(appId: string): string {
  return `flui-${appId}`;
}

/**
 * The repository password: HKDF-SHA256 over the destination passphrase,
 * bound to the application.
 *
 * Deterministic on purpose: a restore recomputes it from the same sealed
 * passphrase and nothing new is stored. Bound to the application so the key
 * of one repository opens no other.
 */
export function deriveKopiaPassword(passphrase: string, appId: string): string {
  if (!passphrase) throw new Error('A backup passphrase is required');
  if (!appId) throw new Error('An application id is required');
  return Buffer.from(
    hkdfSync(
      'sha256',
      passphrase,
      Buffer.alloc(0),
      `flui/kopia/v1/${appId}`,
      32,
    ),
  ).toString('base64url');
}

/** A restore never mints a key: a destination without one cannot open the repository. */
export function kopiaRestorePassword(
  passphrase: string | undefined,
  appId: string,
  destinationName: string,
): string {
  if (!passphrase) {
    throw new Error(
      `Destination "${destinationName}" holds no passphrase, so the kopia repository cannot be opened`,
    );
  }
  return deriveKopiaPassword(passphrase, appId);
}

export interface KopiaS3Location {
  bucket: string;
  /** `host[:port]`, the form kopia's `--endpoint` takes. */
  endpoint: string;
  disableTls: boolean;
  region: string;
  /** Full key prefix in the bucket, with a trailing slash. */
  prefix: string;
}

/** kopia takes a host, not a URL; `http://` means the TLS layer is off. */
export function kopiaEndpoint(endpoint: string): {
  host: string;
  disableTls: boolean;
} {
  const raw = endpoint.trim();
  if (!raw) throw new Error('The destination has no endpoint');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported endpoint scheme ${url.protocol}`);
  }
  if (url.pathname && url.pathname !== '/') {
    throw new Error(
      `The endpoint ${endpoint} carries a path; kopia needs the bare host`,
    );
  }
  return { host: url.host, disableTls: url.protocol === 'http:' };
}

export function kopiaLocation(
  dest: {
    bucket: string;
    endpoint: string;
    region?: string | null;
    pathPrefix?: string | null;
  },
  appId: string,
): KopiaS3Location {
  const { host, disableTls } = kopiaEndpoint(dest.endpoint);
  return {
    bucket: dest.bucket,
    endpoint: host,
    disableTls,
    region: dest.region || '',
    prefix: kopiaBucketPrefix(dest.pathPrefix, appId),
  };
}

/** The storage arguments of `repository connect|create`. No secret is among them. */
export function kopiaStorageArgs(loc: KopiaS3Location): string[] {
  return [
    's3',
    `--bucket=${loc.bucket}`,
    `--endpoint=${loc.endpoint}`,
    `--prefix=${loc.prefix}`,
    ...(loc.region ? [`--region=${loc.region}`] : []),
    ...(loc.disableTls ? ['--disable-tls'] : []),
  ];
}

export function kopiaIdentityArgs(user: string, appId: string): string[] {
  return [
    `--override-username=${user}`,
    `--override-hostname=${kopiaHostname(appId)}`,
  ];
}

/** Bounded caches: kopia's defaults are sized for a workstation, not a Job. */
export const KOPIA_CACHE_ARGS = [
  '--content-cache-size-mb=256',
  '--metadata-cache-size-mb=256',
];

/**
 * The password stays in the environment it came in: never written next to the
 * configuration, and so never handed to an OS keyring either.
 */
export const KOPIA_NO_CREDENTIAL_STORE_ARGS = ['--no-persist-credentials'];

/** Arguments that fix the repository's format. They matter only on creation. */
export const KOPIA_CREATE_ARGS = [
  `--object-splitter=${KOPIA_SPLITTER}`,
  `--encryption=${KOPIA_ENCRYPTION}`,
];

/**
 * Where each volume is mounted in the Job, which is also the snapshot's
 * source path. Distinct per volume, so each volume is its own source with its
 * own history and retention.
 */
export function kopiaSourcePath(volumeName: string): string {
  assertVolumeName(volumeName);
  return `/flui/volumes/${volumeName}`;
}

/**
 * The SQLite online-backup copies of a volume, snapshotted as a second source
 * and laid over the first on restore.
 */
export function kopiaSqliteSourcePath(volumeName: string): string {
  assertVolumeName(volumeName);
  return `/flui/sqlite/${volumeName}/data`;
}

function assertVolumeName(name: string): void {
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(name)) {
    throw new Error(`"${name}" is not a volume name`);
  }
}

/** What the ledger records about one kopia snapshot. */
export interface KopiaSnapshotRecord {
  snapshotId: string;
  /** The root directory object, which `kopia show` lists. */
  rootObject: string;
  source: string;
  /** SQLite online-backup copies, restored over the volume. */
  sqlite?: { snapshotId: string; rootObject: string; source: string };
  repositoryPrefix: string;
  logicalBytes?: number;
  fileCount?: number;
  /** New bytes the repository grew by with this snapshot. */
  uploadedBytes?: number;
  /** Everything the repository stores after this snapshot. */
  repositoryBytes?: number;
  compression: string;
  encryption: string;
  splitter: string;
  durationSeconds?: number;
  pinned: boolean;
  maintenance?: 'quick' | 'full';
  verifiedAt?: string;
  kopiaVersion: string;
}
