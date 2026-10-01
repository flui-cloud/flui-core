import {
  KOPIA_API_USER,
  KOPIA_IMAGE,
  KopiaS3Location,
} from './kopia-repository.util';
import {
  KOPIA_JOB_RESOURCES,
  KOPIA_WORK_VOLUME,
  kopiaConnectScript,
  kopiaJobDeadlineSeconds,
  kopiaJobPlacement,
  kopiaJobShell,
  kopiaLocationEnv,
  kopiaScriptCommand,
  kopiaSecretName,
} from './kopia-job.manifest';

export interface KopiaRestoreJobInput {
  jobName: string;
  namespace: string;
  /** The application whose repository is read — not always the target's. */
  repositoryAppId: string;
  location: KopiaS3Location;
  targetPvcName: string;
  primarySnapshotId: string;
  sqliteSnapshotId?: string;
  /** Restore only these paths, relative to the volume root. */
  paths?: string[];
  /** Restore under this directory of the target instead of its root. */
  targetDirectory?: string;
  nodeName?: string;
  sizeGb?: number;
  labels: Record<string, string>;
}

function restoreScript(input: KopiaRestoreJobInput): string {
  const clean = `find "$dst" -type f ! -name '*-wal' ! -name '*-shm' ! -name '*-journal' 2>/dev/null | while IFS= read -r f; do rm -f "$f-wal" "$f-shm" "$f-journal"; done`;
  const whole = [
    'kopia snapshot restore "$FLUI_KOPIA_PRIMARY" "$D" --no-progress >/dev/null',
    'if [ -n "${FLUI_KOPIA_SQLITE:-}" ]; then kopia snapshot restore "$FLUI_KOPIA_SQLITE" "$D" --no-progress >/dev/null; fi',
  ];
  const selected = [
    `printf '%s' "$FLUI_KOPIA_PATHS" | base64 -d > "$W/paths"`,
    'N=0',
    'while IFS= read -r p || [ -n "$p" ]; do',
    '  [ -n "$p" ] || continue',
    '  dst="$D/$p"',
    '  mkdir -p "$(dirname "$dst")"',
    '  ok=0',
    '  if kopia snapshot restore "$FLUI_KOPIA_PRIMARY/$p" "$dst" --no-progress >/dev/null 2>"$W/err"; then ok=1; fi',
    '  if [ -n "${FLUI_KOPIA_SQLITE:-}" ] && kopia snapshot restore "$FLUI_KOPIA_SQLITE/$p" "$dst" --no-progress >/dev/null 2>>"$W/err"; then',
    '    ok=1',
    // A database restored over a live one must not meet the old journal.
    `    ${clean}`,
    '  fi',
    '  if [ "$ok" != 1 ]; then echo "FLUI_KOPIA_MISSING=$p"; tail -c 400 "$W/err" >&2; exit 1; fi',
    '  N=$((N + 1))',
    'done < "$W/paths"',
    'echo "FLUI_KOPIA_RESTORED_PATHS=$N"',
  ];
  return [
    ...kopiaConnectScript(KOPIA_API_USER, { create: false }),
    'D=/flui/restore',
    'if [ -n "${FLUI_KOPIA_TARGET_DIR:-}" ]; then D="$D/$FLUI_KOPIA_TARGET_DIR"; fi',
    'mkdir -p "$D"',
    ...(input.paths?.length ? selected : whole),
    'sync',
    `echo "FLUI_ACTUAL_BYTES=$(du -sb "$D" | awk '{print $1}')"`,
    'kopia repository disconnect >/dev/null 2>&1 || true',
  ].join('\n');
}

export function renderKopiaRestoreJob(
  input: KopiaRestoreJobInput,
): Record<string, unknown> {
  const env = [
    ...kopiaLocationEnv(input.location, input.repositoryAppId),
    { name: 'FLUI_KOPIA_PRIMARY', value: input.primarySnapshotId },
    ...(input.sqliteSnapshotId
      ? [{ name: 'FLUI_KOPIA_SQLITE', value: input.sqliteSnapshotId }]
      : []),
    ...(input.paths?.length
      ? [
          {
            name: 'FLUI_KOPIA_PATHS',
            value: Buffer.from(input.paths.join('\n'), 'utf-8').toString(
              'base64',
            ),
          },
        ]
      : []),
    ...(input.targetDirectory
      ? [{ name: 'FLUI_KOPIA_TARGET_DIR', value: input.targetDirectory }]
      : []),
  ];
  return kopiaJobShell({
    jobName: input.jobName,
    namespace: input.namespace,
    labels: input.labels,
    deadlineSeconds: kopiaJobDeadlineSeconds(input.sizeGb),
    podSpec: {
      ...kopiaJobPlacement(input.nodeName),
      containers: [
        {
          name: 'kopia',
          image: KOPIA_IMAGE,
          command: kopiaScriptCommand(restoreScript(input)),
          env,
          envFrom: [{ secretRef: { name: kopiaSecretName(input.jobName) } }],
          resources: KOPIA_JOB_RESOURCES,
          volumeMounts: [
            { name: 'target', mountPath: '/flui/restore' },
            { name: 'work', mountPath: '/flui/work' },
          ],
        },
      ],
      volumes: [
        {
          name: 'target',
          persistentVolumeClaim: { claimName: input.targetPvcName },
        },
        KOPIA_WORK_VOLUME,
      ],
    },
  });
}
