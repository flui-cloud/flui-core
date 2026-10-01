import { sqliteSnapshotInitContainer } from '../../providers/services/sqlite-snapshot.util';
import {
  KOPIA_COMPRESSION,
  KOPIA_IMAGE,
  KOPIA_JOB_USER,
  KOPIA_MANUAL_PIN,
  KopiaS3Location,
  kopiaHostname,
  kopiaSourcePath,
  kopiaSqliteSourcePath,
} from './kopia-repository.util';
import {
  KOPIA_FULL_MAINTENANCE_INTERVAL,
  KOPIA_QUICK_MAINTENANCE_INTERVAL,
  KOPIA_VERIFY_PERCENT,
  KopiaRetention,
  kopiaRetentionArgs,
} from './kopia-retention.util';
import {
  KOPIA_CHECKPOINT_INTERVAL,
  KOPIA_JOB_RESOURCES,
  KOPIA_UPLOAD_PARALLELISM,
  KOPIA_WORK_VOLUME,
  kopiaConnectScript,
  kopiaJobDeadlineSeconds,
  kopiaJobPlacement,
  kopiaJobShell,
  kopiaLocationEnv,
  kopiaScriptCommand,
  kopiaSecretName,
} from './kopia-job.manifest';

/**
 * `pre-deploy` snapshots live under a source of their own, so the history they
 * keep (kopia's retention, per source) is the points before deploys, and a
 * nightly snapshot on the same day never pushes one of them out.
 */
export type KopiaTrigger = 'scheduled' | 'manual' | 'pre-deploy';

export interface KopiaSnapshotJobInput {
  jobName: string;
  namespace: string;
  appId: string;
  volumeName: string;
  location: KopiaS3Location;
  /**
   * The policy's retention, re-applied on every scheduled run. An ad-hoc copy
   * leaves the repository's retention alone — setting defaults there would
   * expire what a policy's longer retention still keeps — and applies the
   * defaults only to a repository it has just created.
   */
  retention: KopiaRetention;
  applyRetention: boolean;
  /** Pinned snapshots never expire: an ad-hoc copy is removed by a person. */
  pin: boolean;
  description: string;
  trigger: KopiaTrigger;
  /** SQLite online-backup copies are taken first and snapshotted beside the volume. */
  sqlite: boolean;
  verify: boolean;
  /** The node that holds the volume's data. */
  nodeName?: string;
  sizeGb?: number;
  labels: Record<string, string>;
}

function snapshotScript(input: KopiaSnapshotJobInput): string {
  const pin = input.pin ? ` --pin=${KOPIA_MANUAL_PIN}` : '';
  // An ad-hoc snapshot is written under a source of its own, so it never
  // takes a daily or weekly slot from the schedule's history, and its pin
  // keeps it until a person removes it.
  const override = (target: string) =>
    input.pin || input.trigger === 'pre-deploy'
      ? ` --override-source="${target}"`
      : '';
  const create = (src: string, target: string, out: string) =>
    `nice -n 10 kopia snapshot create "${src}"${override(target)} --no-progress --parallel=${KOPIA_UPLOAD_PARALLELISM} --checkpoint-interval=${KOPIA_CHECKPOINT_INTERVAL} --description="$FLUI_KOPIA_DESCRIPTION" --tags="flui-volume:$FLUI_KOPIA_VOLUME" --tags="flui-trigger:${input.trigger}"${pin} --json > "$W/${out}.json"`;
  return [
    ...kopiaConnectScript(KOPIA_JOB_USER, { create: true }),
    // Re-applied on every run, so a policy change reaches the repository on
    // its next snapshot, and the owner stays the one identity every Job uses.
    `kopia maintenance set --owner=me --enable-quick=true --quick-interval=${KOPIA_QUICK_MAINTENANCE_INTERVAL} --enable-full=true --full-interval=${KOPIA_FULL_MAINTENANCE_INTERVAL} >/dev/null`,
    `kopia policy set --global --compression=${KOPIA_COMPRESSION} >/dev/null`,
    input.applyRetention
      ? `kopia policy set --global ${kopiaRetentionArgs(input.retention).join(' ')} >/dev/null`
      : `if [ "\${CREATED:-0}" = 1 ]; then kopia policy set --global ${kopiaRetentionArgs(input.retention).join(' ')} >/dev/null; fi`,
    'SRC="$FLUI_KOPIA_SOURCE"',
    'TGT="$FLUI_KOPIA_TARGET"',
    'kopia policy set "$TGT" --clear-ignore >/dev/null',
    ...(input.sqlite
      ? [
          // The live database files are left out of the volume's snapshot:
          // their consistent copies are the second snapshot, laid over the
          // first on restore.
          'SQL="$FLUI_KOPIA_SQLITE_SOURCE"',
          'SQLT="$FLUI_KOPIA_SQLITE_TARGET"',
          'mkdir -p "$SQL"',
          'find "$SQL" -type f | while IFS= read -r f; do',
          '  rel="${f#"$SQL"/}"',
          String.raw`  esc="$(printf '%s' "$rel" | sed 's/[][*?\\]/\\&/g')"`,
          '  for s in "" -wal -shm -journal; do kopia policy set "$TGT" "--add-ignore=/$esc$s" >/dev/null; done',
          'done',
        ]
      : []),
    `BEFORE="$(kopia blob stats --raw 2>/dev/null | awk '/^Total:/{print $2}')"`,
    'START="$(date +%s)"',
    create('$SRC', '$TGT', 'primary'),
    ...(input.sqlite ? [create('$SQL', '$SQLT', 'sqlite')] : []),
    'END="$(date +%s)"',
    `AFTER="$(kopia blob stats --raw 2>/dev/null | awk '/^Total:/{print $2}')"`,
    'echo "FLUI_KOPIA_SNAPSHOT=$(base64 -w0 < "$W/primary.json")"',
    ...(input.sqlite
      ? ['echo "FLUI_KOPIA_SQLITE_SNAPSHOT=$(base64 -w0 < "$W/sqlite.json")"']
      : []),
    'echo "FLUI_KOPIA_BYTES_BEFORE=${BEFORE:-}"',
    'echo "FLUI_KOPIA_BYTES_AFTER=${AFTER:-}"',
    'echo "FLUI_KOPIA_SECONDS=$((END - START))"',
    // Quick maintenance after every snapshot; full when kopia's own weekly
    // schedule says it is due. A maintenance failure is reported, never
    // allowed to fail a snapshot that already exists.
    `NEXT="$(kopia maintenance info --json 2>/dev/null | grep -o '"nextFullMaintenance":"[^"]*"' | cut -d'"' -f4 || true)"`,
    'DUE="$(date -u -d "${NEXT:-2999-01-01T00:00:00Z}" +%s 2>/dev/null || echo 32503680000)"',
    'if [ "$DUE" -le "$(date -u +%s)" ]; then MODE=full; FULL=--full; else MODE=quick; FULL=; fi',
    'if nice -n 10 kopia maintenance run $FULL >/dev/null 2>&1; then echo "FLUI_KOPIA_MAINTENANCE=$MODE"; else echo "FLUI_KOPIA_MAINTENANCE=failed"; fi',
    ...(input.verify
      ? [
          `if nice -n 10 kopia snapshot verify --verify-files-percent=${KOPIA_VERIFY_PERCENT} --file-parallelism=${KOPIA_UPLOAD_PARALLELISM} >/dev/null 2>"$W/verify.err"; then echo FLUI_KOPIA_VERIFIED=ok; else echo FLUI_KOPIA_VERIFIED=failed; tail -c 400 "$W/verify.err" >&2; fi`,
        ]
      : []),
    'echo "FLUI_KOPIA_SNAPSHOTS=$(kopia snapshot list "$TGT" --json | base64 -w0)"',
    ...(input.sqlite
      ? [
          'echo "FLUI_KOPIA_SQLITE_SNAPSHOTS=$(kopia snapshot list "$SQLT" --json | base64 -w0)"',
        ]
      : []),
    'kopia repository disconnect >/dev/null 2>&1 || true',
  ].join('\n');
}

/**
 * The kopia source a snapshot is recorded under: the mount path itself for a
 * scheduled one, a parallel `/flui/manual/...` path for an ad-hoc one and
 * `/flui/pre-deploy/...` for one taken before a deploy.
 */
export function kopiaSnapshotTarget(
  input: Pick<KopiaSnapshotJobInput, 'pin' | 'appId'> & {
    trigger?: KopiaTrigger;
  },
  path: string,
): string {
  let folder: string;
  if (input.pin) folder = '/flui/manual/';
  else if (input.trigger === 'pre-deploy') folder = '/flui/pre-deploy/';
  else return path;
  const source = path.replace(/^\/flui\//, folder);
  return `${KOPIA_JOB_USER}@${kopiaHostname(input.appId)}:${source}`;
}

export function renderKopiaSnapshotJob(
  input: KopiaSnapshotJobInput,
): Record<string, unknown> {
  const source = kopiaSourcePath(input.volumeName);
  const sqliteSource = kopiaSqliteSourcePath(input.volumeName);
  const env = [
    ...kopiaLocationEnv(input.location, input.appId),
    { name: 'FLUI_KOPIA_SOURCE', value: source },
    { name: 'FLUI_KOPIA_TARGET', value: kopiaSnapshotTarget(input, source) },
    { name: 'FLUI_KOPIA_VOLUME', value: input.volumeName },
    { name: 'FLUI_KOPIA_DESCRIPTION', value: input.description },
    ...(input.sqlite
      ? [
          { name: 'FLUI_KOPIA_SQLITE_SOURCE', value: sqliteSource },
          {
            name: 'FLUI_KOPIA_SQLITE_TARGET',
            value: kopiaSnapshotTarget(input, sqliteSource),
          },
        ]
      : []),
  ];
  const volumeMounts = [
    { name: 'src', mountPath: source, readOnly: true },
    { name: 'work', mountPath: '/flui/work' },
    ...(input.sqlite
      ? [{ name: 'stage', mountPath: sqliteSource.replace(/\/data$/, '') }]
      : []),
  ];
  return kopiaJobShell({
    jobName: input.jobName,
    namespace: input.namespace,
    labels: input.labels,
    deadlineSeconds: kopiaJobDeadlineSeconds(input.sizeGb),
    podSpec: {
      ...kopiaJobPlacement(input.nodeName),
      ...(input.sqlite
        ? { initContainers: [sqliteSnapshotInitContainer()] }
        : {}),
      containers: [
        {
          name: 'kopia',
          image: KOPIA_IMAGE,
          command: kopiaScriptCommand(snapshotScript(input)),
          env,
          envFrom: [{ secretRef: { name: kopiaSecretName(input.jobName) } }],
          resources: KOPIA_JOB_RESOURCES,
          volumeMounts,
        },
      ],
      volumes: [
        {
          name: 'src',
          persistentVolumeClaim: {
            claimName: input.volumeName,
            // The SQLite step reads a database in WAL mode, which needs its
            // shared-memory file: writable for the init container only.
            readOnly: !input.sqlite,
          },
        },
        KOPIA_WORK_VOLUME,
        ...(input.sqlite ? [{ name: 'stage', emptyDir: {} }] : []),
      ],
    },
  });
}
