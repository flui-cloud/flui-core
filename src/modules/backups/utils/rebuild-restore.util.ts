import { createHash } from 'node:crypto';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  CompanionsSpec,
  SidecarSpec,
} from '../../applications/services/application-manifest-generator.service';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { cryptSetupScript } from './rclone-crypt.util';
import {
  KOPIA_IMAGE,
  KopiaS3Location,
  KopiaSnapshotRecord,
} from './kopia-repository.util';
import { KOPIA_JOB_RESOURCES } from './kopia-job.manifest';
import { VolumeRestoreRoute, volumeRestoreRoute } from './kopia-restore.util';
import {
  KOPIA_RESTORE_ACCESS_KEY_ENV,
  KOPIA_RESTORE_PASSWORD_ENV,
  KOPIA_RESTORE_SECRET_KEY_ENV,
  KOPIA_RESTORE_WORK_MOUNT,
  kopiaRebuildRestoreEnv,
  kopiaRebuildRestoreScript,
} from './kopia-rebuild-restore.util';

type AppEnv = NonNullable<ApplicationEntity['env']>;

/** What one part of an application's data ended up doing. */
export type RestoredWith =
  | { kind: 'database'; what: string; from: string }
  | { kind: 'volume'; what: string; from: string }
  | { kind: 'empty'; what: string; why: string };

/** What one pod needs to fill all of its volumes. */
export interface PodRestore {
  inits: SidecarSpec[];
  credentials: BackupDestinationEntity | null;
  anyEncrypted: boolean;
  anyArchive: boolean;
  kopiaPassword: string | null;
}

export function emptyPodRestore(): PodRestore {
  return {
    inits: [],
    credentials: null,
    anyEncrypted: false,
    anyArchive: false,
    kopiaPassword: null,
  };
}

export function emptyDatabase(why: string): RestoredWith {
  return { kind: 'empty', what: 'database', why };
}

export function databaseDumpOutcome(engineRef?: string | null): RestoredWith {
  return engineRef
    ? {
        kind: 'database',
        what: 'database',
        from: `the dump ${engineRef}, loaded once the database is running`,
      }
    : emptyDatabase(
        'the newest dump does not name the object it was written to',
      );
}

/** For a database under continuous backup the absence is correct. */
export function noVolumeCopyReason(databaseHandled: boolean): string {
  return databaseHandled
    ? "no separate copy of this volume: the database's own data comes " +
        'back through its engine, anything else stored beside it does not'
    : 'no object-store copy has been taken, so it comes back empty';
}

/** Names every companion a rebuild adds, so a later run can replace them. */
export const RESTORE_INIT_PREFIX = 'flui-restore-';
/** Every environment name a rebuild writes, so all of them can be removed. */
export const RESTORE_ENV_PREFIXES = ['RCLONE_CONFIG_FLUI_', 'FLUI_RESTORE_'];
export const RESTORE_CRYPT_PREFIX = 'FLUI_RESTORE_CRYPT_';
const RESTORE_MOUNT = '/flui-restore';
const RCLONE_IMAGE = 'rclone/rclone:1.67';
/** kopia's configuration and cache, apart from the volume being filled. */
const KOPIA_WORK_VOLUME = `${RESTORE_INIT_PREFIX}kopia-work`;

const CONSISTENT_QUIESCE = new Set([
  'engine-hook',
  'sqlite-snapshot',
  'writers-stopped',
]);

const hasPrefix = (name: string, prefixes: string[]): boolean =>
  prefixes.some((p) => name.startsWith(p));

/** True when there was something to remove. */
export function clearRestoreDeclaration(
  app: ApplicationEntity,
  enginePrefixes: string[],
): boolean {
  const companions = (app.companions ?? {}) as CompanionsSpec;
  const inits = companions.initContainers ?? [];
  const keptInits = inits.filter(
    (c) => !c.name.startsWith(RESTORE_INIT_PREFIX),
  );
  const env = app.env ?? [];
  // The engines' own restore variables go too — same one boot.
  const finalEnv = env.filter(
    (e) =>
      !hasPrefix(e.name, RESTORE_ENV_PREFIXES) &&
      !hasPrefix(e.name, enginePrefixes),
  );
  const volumes = companions.volumes ?? [];
  const keptVolumes = volumes.filter(
    (v) => !v.name.startsWith(RESTORE_INIT_PREFIX),
  );

  const changed =
    keptInits.length !== inits.length ||
    finalEnv.length !== env.length ||
    keptVolumes.length !== volumes.length;
  if (!changed) return false;

  app.companions = {
    ...companions,
    initContainers: keptInits,
    ...(companions.volumes ? { volumes: keptVolumes } : {}),
  } as ApplicationEntity['companions'];
  app.env = finalEnv as ApplicationEntity['env'];
  return true;
}

/** The row is what the manifest is rendered from. */
export function withEngineRestoreEnv(
  env: AppEnv | undefined,
  enginePrefix: string,
  restoreEnv: Record<string, string>,
): ApplicationEntity['env'] {
  return [
    ...(env ?? []).filter((e) => !e.name.startsWith(enginePrefix)),
    ...Object.entries(restoreEnv).map(([name, value]) => ({
      name,
      value,
      secret: /KEY|SECRET|PASS/.test(name),
    })),
  ] as ApplicationEntity['env'];
}

export function withRestoreInits(
  companionsValue: ApplicationEntity['companions'],
  inits: SidecarSpec[],
  kopiaWork: boolean,
): ApplicationEntity['companions'] {
  const companions = (companionsValue ?? {}) as CompanionsSpec;
  return {
    ...companions,
    initContainers: [...(companions.initContainers ?? []), ...inits],
    ...(kopiaWork
      ? {
          volumes: [
            ...(companions.volumes ?? []),
            { name: KOPIA_WORK_VOLUME, emptyDir: { sizeLimit: '2Gi' } },
          ],
        }
      : {}),
  } as ApplicationEntity['companions'];
}

export type FileRestoreRoute = Extract<
  VolumeRestoreRoute,
  { kind: 'kopia' | 's3-archive' }
>;

/** The copy a volume can be filled from as files, or why it cannot. */
export function volumeCopyRoute(
  artifact: BackupArtifactEntity,
  databaseHandled: boolean,
): { route: FileRestoreRoute; prefix?: string } | { refused: string } {
  const refused = refusedAsFiles(artifact.manifestSummary, databaseHandled);
  if (refused) return { refused };
  const primary = artifact.locations?.find(
    (l) => l.role === DestinationRole.PRIMARY,
  );
  if (
    primary?.state === ArtifactLocationState.EXPIRED ||
    primary?.state === ArtifactLocationState.MISSING
  ) {
    return { refused: 'its newest copy is no longer in the bucket' };
  }
  const route = volumeRestoreRoute(artifact);
  if (route.kind === 'unavailable') return { refused: route.reason };
  if (route.kind === 'pvc-clone') {
    return { refused: 'its newest copy is a volume on the lost cluster' };
  }
  return { route, prefix: primary?.objectKeyPrefix };
}

/**
 * kopia rather than a Job filling the claim first: the claim binds to the
 * node of whichever pod mounts it first, so filling it in the pod that will
 * use it is what keeps the two on one node.
 */
export function kopiaRestoreInitContainer(
  volumeName: string,
  location: KopiaS3Location,
  repositoryAppId: string,
  record: KopiaSnapshotRecord,
): SidecarSpec {
  return {
    name: restoreContainerName(volumeName),
    image: KOPIA_IMAGE,
    imagePullPolicy: 'IfNotPresent',
    command: ['/bin/sh', '-c', kopiaRebuildRestoreScript(RESTORE_MOUNT)],
    // The password and the keys come from the application's own Secret;
    // what is here names a bucket and a snapshot and nothing that opens them.
    inheritAppEnv: true,
    env: kopiaRebuildRestoreEnv(location, repositoryAppId, record),
    mounts: [
      { name: volumeName, mountPath: RESTORE_MOUNT },
      { name: KOPIA_WORK_VOLUME, mountPath: KOPIA_RESTORE_WORK_MOUNT },
    ],
    cpuRequest: KOPIA_JOB_RESOURCES.requests.cpu,
    memoryRequest: KOPIA_JOB_RESOURCES.requests.memory,
    cpuLimit: KOPIA_JOB_RESOURCES.limits.cpu,
    memoryLimit: KOPIA_JOB_RESOURCES.limits.memory,
  };
}

export function withKopiaRestoreEnv(
  env: AppEnv | undefined,
  password: string,
  accessKey: string,
  secretKey: string,
): ApplicationEntity['env'] {
  const names = new Set([
    KOPIA_RESTORE_PASSWORD_ENV,
    KOPIA_RESTORE_ACCESS_KEY_ENV,
    KOPIA_RESTORE_SECRET_KEY_ENV,
  ]);
  return [
    ...(env ?? []).filter((e) => !names.has(e.name)),
    { name: KOPIA_RESTORE_PASSWORD_ENV, value: password, secret: true },
    { name: KOPIA_RESTORE_ACCESS_KEY_ENV, value: accessKey, secret: true },
    { name: KOPIA_RESTORE_SECRET_KEY_ENV, value: secretKey, secret: true },
  ] as ApplicationEntity['env'];
}

/**
 * `copy`, never `sync`: a sync would delete what the application wrote after
 * a restart. The marker makes a second run a no-op anyway.
 *
 * Known limit: archives written before `--metadata` carry no uid or mode, so
 * files arrive owned by whoever ran this container.
 */
export function rcloneRestoreInitContainer(
  app: ApplicationEntity,
  volumeName: string,
  prefix: string,
  encrypted: boolean,
): SidecarSpec {
  const sc = app.securityContext as
    | { runAsUser?: number; fsGroup?: number; runAsGroup?: number }
    | undefined;
  const own =
    sc?.runAsUser === undefined
      ? ''
      : `${sc.runAsUser}:${sc.fsGroup ?? sc.runAsGroup ?? sc.runAsUser}`;

  const script = [
    'set -eu',
    `d=${RESTORE_MOUNT}`,
    'if [ -f "$d/.flui-restored" ]; then echo "flui: already restored"; exit 0; fi',
    'echo "flui: restoring $FLUI_RESTORE_PREFIX"',
    'REMOTE=flui',
    'if [ "${FLUI_RESTORE_ENCRYPTED:-}" = 1 ]; then',
    '  [ -n "${FLUI_RESTORE_CRYPT_PASSWORD:-}" ] || { echo "flui: the copy is encrypted and no key was provided"; exit 1; }',
    cryptSetupScript({ envPrefix: RESTORE_CRYPT_PREFIX }),
    '  REMOTE=flui_crypt',
    'fi',
    'rclone copy --metadata "$REMOTE:$FLUI_RESTORE_BUCKET/$FLUI_RESTORE_PREFIX" "$d" --transfers 8 --checkers 16 --stats 30s --stats-one-line',
    'if [ -n "${FLUI_RESTORE_OWN:-}" ]; then chown -R "$FLUI_RESTORE_OWN" "$d" || echo "flui: ownership unchanged"; fi',
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$d/.flui-restored"',
    'echo "flui: restore complete"',
  ].join('\n');

  return {
    name: restoreContainerName(volumeName),
    image: RCLONE_IMAGE,
    imagePullPolicy: 'IfNotPresent',
    command: ['/bin/sh', '-c', script],
    // The bucket and the credentials are the same for the whole pod and live
    // in the application's own Secret; only the path differs per volume.
    inheritAppEnv: true,
    env: [
      { name: 'FLUI_RESTORE_PREFIX', value: prefix },
      { name: 'FLUI_RESTORE_OWN', value: own },
      { name: 'FLUI_RESTORE_ENCRYPTED', value: encrypted ? '1' : '' },
    ],
    mounts: [{ name: volumeName, mountPath: RESTORE_MOUNT }],
    cpuRequest: '50m',
    memoryRequest: '64Mi',
    cpuLimit: '1000m',
    memoryLimit: '512Mi',
  };
}

/** From the environment, so the secret half lands in the application's
 * Secret rather than in the pod spec. */
export function withRcloneRestoreEnv(
  env: AppEnv | undefined,
  destination: BackupDestinationEntity,
  accessKey: string,
  secretKey: string,
  cryptValues: Record<string, string> | null,
): ApplicationEntity['env'] {
  const values: Array<[string, string, boolean]> = [
    ['RCLONE_CONFIG_FLUI_TYPE', 's3', false],
    ['RCLONE_CONFIG_FLUI_PROVIDER', 'Other', false],
    ['RCLONE_CONFIG_FLUI_ENDPOINT', destination.endpoint, false],
    ['RCLONE_CONFIG_FLUI_REGION', destination.region || 'auto', false],
    ['RCLONE_CONFIG_FLUI_ACCESS_KEY_ID', accessKey, true],
    ['RCLONE_CONFIG_FLUI_SECRET_ACCESS_KEY', secretKey, true],
    ['FLUI_RESTORE_BUCKET', destination.bucket, false],
    ...Object.entries(cryptValues ?? {}).map(
      ([name, value]): [string, string, boolean] => [name, value, true],
    ),
  ];
  return [
    ...(env ?? []).filter((e) => !hasPrefix(e.name, RESTORE_ENV_PREFIXES)),
    ...values.map(([name, value, secret]) => ({ name, value, secret })),
  ] as ApplicationEntity['env'];
}

/**
 * Why a volume's copy is not put back as files, or nothing when it is.
 *
 * The copy's preflight saw a data directory on it. A file copy of a running
 * database restores into something that does not start, unless the engine put
 * a whole image on disk first or nothing was writing: then the copy is the
 * restore. A database whose engine restores it is left to the engine.
 */
export function refusedAsFiles(
  summary: Record<string, unknown> | undefined,
  databaseHandled: boolean,
): string | undefined {
  const detected = summary?.dataDirectoryDetected as string | undefined;
  if (!detected) return undefined;
  if (databaseHandled) {
    return `holds the ${detected} data directory — recovered through its engine, not as a file copy`;
  }
  const consistent =
    CONSISTENT_QUIESCE.has(summary?.quiesce as string) &&
    summary?.acknowledgedInconsistent !== true;
  if (consistent) return undefined;
  return (
    `holds a ${detected} data directory: a file copy of one does not restore. ` +
    'Enable continuous backup for this database so it can come back'
  );
}

export function takenOn(at: Date | string | undefined): string {
  if (!at) return '';
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : `, taken ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function trimTrailingDashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '-') end--;
  return value.slice(0, end);
}

function isDnsLabel(value: string): boolean {
  return (
    /^[a-z0-9-]+$/.test(value) && !value.startsWith('-') && !value.endsWith('-')
  );
}

/**
 * A DNS label: truncating a long volume name can end on a dash, and two
 * volumes sharing a prefix collide — either rejects the whole pod.
 */
export function restoreContainerName(volumeName: string): string {
  const natural = `${RESTORE_INIT_PREFIX}${volumeName}`.toLowerCase();
  if (natural.length <= 63 && isDnsLabel(natural)) return natural;
  const digest = createHash('sha256')
    .update(volumeName)
    .digest('hex')
    .slice(0, 6);
  const stem = trimTrailingDashes(
    natural.replaceAll(/[^a-z0-9-]/g, '-').slice(0, 63 - digest.length - 1),
  );
  return `${stem}-${digest}`;
}
