import { createHash } from 'node:crypto';
import {
  KOPIA_ENCRYPTION,
  KOPIA_SPLITTER,
  KopiaS3Location,
  kopiaHostname,
} from './kopia-repository.util';

/**
 * The kopia Jobs, rendered as plain objects.
 *
 * Nothing secret is ever in them: the repository password and the storage
 * keys reach the container through a Secret that lives exactly as long as the
 * Job, and every other value — bucket, prefix, a description a person typed —
 * is passed as an environment variable and quoted where the script uses it, so
 * no name can become shell.
 */

/** Requests small enough for a small node, limits that stop a runaway. */
export const KOPIA_JOB_RESOURCES = {
  requests: { cpu: '100m', memory: '256Mi' },
  limits: { cpu: '1', memory: '1Gi' },
} as const;

/** Below the memory limit, so Go collects before the kernel kills. */
export const KOPIA_GOMEMLIMIT = '900MiB';
export const KOPIA_UPLOAD_PARALLELISM = 2;
export const KOPIA_CHECKPOINT_INTERVAL = '10m';

const BASE_DEADLINE_SECONDS = 30 * 60;
const SECONDS_PER_GIB = 60;
const MAX_DEADLINE_SECONDS = 12 * 60 * 60;

/**
 * Thirty minutes plus a minute per GiB of the volume's size, at most twelve
 * hours.
 *
 * The first snapshot of a large volume uploads all of it; later ones upload
 * only what changed. A deadline sized for the second kills the first every
 * night, which is why it scales — and a Job killed at its deadline is not
 * wasted, because kopia checkpoints every ten minutes and the next run
 * continues from the last checkpoint instead of starting over.
 */
export function kopiaJobDeadlineSeconds(sizeGb: number | undefined): number {
  const gib = Number.isFinite(sizeGb) && sizeGb! > 0 ? Math.ceil(sizeGb!) : 0;
  return Math.min(
    MAX_DEADLINE_SECONDS,
    BASE_DEADLINE_SECONDS + gib * SECONDS_PER_GIB,
  );
}

/** Same repository, same label: how two Jobs on one repository see each other. */
export function kopiaRepositoryLabel(
  destinationId: string,
  appId: string,
): string {
  return createHash('sha256')
    .update(`${destinationId}/${appId}`)
    .digest('hex')
    .slice(0, 32);
}

export const KOPIA_REPO_LABEL = 'flui.cloud/kopia-repository';

export function kopiaJobName(kind: 'snap' | 'restore', seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 20);
  return `kopia-${kind}-${hash}`;
}

export function kopiaSecretName(jobName: string): string {
  return `${jobName}-secret`;
}

export interface KopiaSecretInput {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  password: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function renderKopiaSecret(
  input: KopiaSecretInput,
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: input.labels,
    },
    type: 'Opaque',
    stringData: {
      KOPIA_PASSWORD: input.password,
      AWS_ACCESS_KEY_ID: input.accessKeyId,
      AWS_SECRET_ACCESS_KEY: input.secretAccessKey,
    },
  };
}

/** Connects, or creates the repository the first time and connects. */
export function kopiaConnectScript(
  user: string,
  opts: { create: boolean },
): string[] {
  const lines = [
    'set -eu',
    'W=/flui/work',
    'mkdir -p "$W"',
    'export KOPIA_CONFIG_PATH="$W/repository.config" KOPIA_CACHE_DIRECTORY="$W/cache" KOPIA_LOG_DIR="$W/logs" KOPIA_CHECK_FOR_UPDATES=false',
    'set -- s3 "--bucket=$FLUI_KOPIA_BUCKET" "--endpoint=$FLUI_KOPIA_ENDPOINT" "--prefix=$FLUI_KOPIA_PREFIX"',
    'if [ -n "${FLUI_KOPIA_REGION:-}" ]; then set -- "$@" "--region=$FLUI_KOPIA_REGION"; fi',
    'if [ "${FLUI_KOPIA_DISABLE_TLS:-0}" = 1 ]; then set -- "$@" --disable-tls; fi',
    `set -- "$@" "--override-username=${user}" "--override-hostname=$FLUI_KOPIA_HOST" --content-cache-size-mb=256 --metadata-cache-size-mb=256 --no-persist-credentials`,
  ];
  if (!opts.create) {
    return [...lines, 'kopia repository connect "$@" --readonly >/dev/null'];
  }
  // A failed connect is either "no repository here yet" or a real fault. The
  // create that follows refuses to write over anything already there, so a
  // wrong password or a bad key ends in the second connect's error, never in
  // a new repository on top of an old one.
  return [
    ...lines,
    'if ! kopia repository connect "$@" >/dev/null 2>&1; then',
    `  kopia repository create "$@" --object-splitter=${KOPIA_SPLITTER} --encryption=${KOPIA_ENCRYPTION} >/dev/null 2>&1 || kopia repository connect "$@" >/dev/null`,
    '  CREATED=1',
    '  echo FLUI_KOPIA_CREATED=1',
    'fi',
  ];
}

export function kopiaJobPlacement(nodeName?: string): Record<string, unknown> {
  if (!nodeName) return {};
  // The Job runs where the volume's data is; a node that keeps other work
  // away with a taint must be tolerated or the Job waits forever.
  return {
    nodeSelector: { 'kubernetes.io/hostname': nodeName },
    tolerations: [
      { operator: 'Exists', effect: 'NoSchedule' },
      { operator: 'Exists', effect: 'PreferNoSchedule' },
    ],
  };
}

export function kopiaLocationEnv(
  loc: KopiaS3Location,
  appId: string,
): Array<{ name: string; value: string }> {
  return [
    { name: 'FLUI_KOPIA_BUCKET', value: loc.bucket },
    { name: 'FLUI_KOPIA_ENDPOINT', value: loc.endpoint },
    { name: 'FLUI_KOPIA_PREFIX', value: loc.prefix },
    { name: 'FLUI_KOPIA_REGION', value: loc.region },
    { name: 'FLUI_KOPIA_DISABLE_TLS', value: loc.disableTls ? '1' : '0' },
    { name: 'FLUI_KOPIA_HOST', value: kopiaHostname(appId) },
    { name: 'GOMEMLIMIT', value: KOPIA_GOMEMLIMIT },
  ];
}

export function kopiaScriptCommand(script: string): string[] {
  // Base64 so no quote, glob or backslash in the script can break out of it.
  return [
    '/bin/sh',
    '-c',
    `echo ${Buffer.from(script, 'utf-8').toString('base64')} | base64 -d | sh`,
  ];
}

export function kopiaJobShell(args: {
  jobName: string;
  namespace: string;
  labels: Record<string, string>;
  deadlineSeconds: number;
  podSpec: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: args.jobName,
      namespace: args.namespace,
      labels: args.labels,
    },
    spec: {
      // One retry: a second pod resumes from kopia's checkpoint.
      backoffLimit: 1,
      activeDeadlineSeconds: args.deadlineSeconds,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: args.labels },
        spec: { restartPolicy: 'Never', ...args.podSpec },
      },
    },
  };
}

export const KOPIA_WORK_VOLUME = {
  name: 'work',
  emptyDir: { sizeLimit: '2Gi' },
};
