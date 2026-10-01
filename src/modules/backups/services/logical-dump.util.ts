import { cryptSetupScript } from '../utils/rclone-crypt.util';

export interface DumpFamilySpec {
  name: 'postgres' | 'mariadb';
  tool: string;
  extension: string;
  defaultPort: number;
  requiredTools: string[];
  identityScript: string;
  versionScript: string;
  toolVersionScript: string;
}

export const DumpFamily = {
  POSTGRES: {
    name: 'postgres',
    tool: 'pg_dump',
    extension: 'pgdump',
    defaultPort: 5432,
    requiredTools: ['bash', 'pg_dump', 'pg_restore'],
    identityScript:
      'printf "%s\\t%s\\n" "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
    versionScript: `postgres --version | awk '{print $3}'`,
    toolVersionScript: `pg_dump --version | awk '{print $3}'`,
  },
  MARIADB: {
    name: 'mariadb',
    tool: 'mariadb-dump',
    extension: 'sql.gz',
    defaultPort: 3306,
    requiredTools: ['bash', 'gzip', 'mariadb-dump|mysqldump', 'mariadb|mysql'],
    identityScript:
      'printf "%s\\t%s\\n" "${MARIADB_USER:-${MYSQL_USER:-root}}" "${MARIADB_DATABASE:-${MYSQL_DATABASE:-}}"',
    versionScript: `(mariadbd --version || mysqld --version) 2>/dev/null | head -1 | awk '{print $3}'`,
    toolVersionScript: `(mariadb-dump --version || mysqldump --version) 2>/dev/null | head -1`,
  },
} as const satisfies Record<string, DumpFamilySpec>;

export type DumpFamily = (typeof DumpFamily)[keyof typeof DumpFamily];

/** Where one database's dumps live, relative to the destination prefix. */
export function dumpPrefix(appId: string): string {
  return `dumps/${appId}/`;
}

export function dumpObjectKey(
  appId: string,
  label: string,
  family: DumpFamilySpec,
): string {
  return `${dumpPrefix(appId)}${label}/dump.${family.extension}`;
}

/** Sortable and safe in an object key: `20260927T134500Z`. */
export function dumpLabel(at: Date): string {
  return at
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function dumpLabelToIso(label: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(label);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

export function toolingProbe(family: DumpFamilySpec): string {
  return family.requiredTools
    .map((alternatives) => {
      const checks = alternatives
        .split('|')
        .map((t) => `command -v ${t} >/dev/null 2>&1`)
        .join(' || ');
      return `{ ${checks}; } || echo MISSING:${alternatives.split('|')[0]}`;
    })
    .concat('echo PROBED')
    .join('\n');
}

const MARIADB_CREDENTIALS = [
  'ROOT_PW="${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}"',
  'if [ -n "$ROOT_PW" ]; then U=root; export MYSQL_PWD="$ROOT_PW"; EXTRA="--routines --triggers --events"',
  'else U="${MARIADB_USER:-${MYSQL_USER:-}}"; export MYSQL_PWD="${MARIADB_PASSWORD:-${MYSQL_PASSWORD:-}}"; EXTRA="--triggers"; fi',
  'DB="${MARIADB_DATABASE:-${MYSQL_DATABASE:-}}"',
  '[ -n "$DB" ] || { echo "no database name in the environment" >&2; exit 1; }',
].join('\n');

const POSTGRES_CREDENTIALS = [
  'U="${POSTGRES_USER:-postgres}"',
  'D="${POSTGRES_DB:-$U}"',
  'export PGPASSWORD="${POSTGRES_PASSWORD:-}"',
].join('\n');

const CRYPT_SETUP = cryptSetupScript({ rclone: '/flui/rclone' });

const REPORT_SIZE = String.raw`echo "FLUI_DUMP_BYTES=$(/flui/rclone size --json "$FLUI_REMOTE" | sed -E 's/.*"bytes":([0-9]+).*/\1/')"`;

export function dumpScript(family: DumpFamilySpec): string {
  if (family.name === 'postgres') {
    return [
      'set -euo pipefail',
      CRYPT_SETUP,
      POSTGRES_CREDENTIALS,
      `pg_dump -h "$FLUI_DB_HOST" -p "$FLUI_DB_PORT" -U "$U" -d "$D" -Fc --no-owner --no-acl | /flui/rclone rcat "$FLUI_REMOTE" --s3-no-check-bucket`,
      REPORT_SIZE,
    ].join('\n');
  }
  return [
    'set -euo pipefail',
    CRYPT_SETUP,
    MARIADB_CREDENTIALS,
    'DUMP=$(command -v mariadb-dump || command -v mysqldump)',
    `"$DUMP" -h "$FLUI_DB_HOST" -P "$FLUI_DB_PORT" -u "$U" --single-transaction --skip-lock-tables $EXTRA "$DB" | gzip | /flui/rclone rcat "$FLUI_REMOTE" --s3-no-check-bucket`,
    REPORT_SIZE,
  ].join('\n');
}

/**
 * Loads a dump into a running database, safe to run twice.
 *
 * Postgres: one transaction, and every object of the dump dropped first when
 * it exists. A load that fails leaves the database as it was; a second one —
 * a retried rebuild, or one that loaded and died before recording it — drops
 * what the first put there instead of stopping at the first existing table,
 * or appending the rows a second time. An object the dump does not own that
 * depends on one it drops fails the load, loudly, rather than being cascaded
 * away. MariaDB's dump already drops each table before creating it.
 */
export function loadScript(family: DumpFamilySpec): string {
  if (family.name === 'postgres') {
    return [
      'set -euo pipefail',
      CRYPT_SETUP,
      POSTGRES_CREDENTIALS,
      `/flui/rclone cat "$FLUI_REMOTE" | pg_restore -h "$FLUI_DB_HOST" -p "$FLUI_DB_PORT" -U "$U" -d "$D" --no-owner --no-acl --clean --if-exists --single-transaction --exit-on-error`,
      'echo FLUI_LOAD_DONE',
    ].join('\n');
  }
  return [
    'set -euo pipefail',
    CRYPT_SETUP,
    MARIADB_CREDENTIALS,
    'CLIENT=$(command -v mariadb || command -v mysql)',
    // mariadb-dump 11 opens with a "sandbox mode" command that older clients
    // reject as an unknown command; it only guards against a malicious dump.
    `/flui/rclone cat "$FLUI_REMOTE" | gunzip | sed '1{/enable the sandbox mode/d}' | "$CLIENT" -h "$FLUI_DB_HOST" -P "$FLUI_DB_PORT" -u "$U" "$DB"`,
    'echo FLUI_LOAD_DONE',
  ].join('\n');
}

export function renderDumpJob(args: {
  jobName: string;
  namespace: string;
  appId: string;
  image: string;
  rcloneImage: string;
  secretName: string;
  script: string;
  env: unknown[];
  envFrom: unknown[];
  imagePullSecrets: unknown[];
  tolerations: unknown[];
  timeoutSeconds: number;
}): Record<string, unknown> {
  // Not `flui-app-id`: every exec into the database finds its pod by that
  // label, and a dump pod carrying it would be picked instead.
  const labels = { 'flui.cloud/dump-of': args.appId };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: args.jobName, namespace: args.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: args.timeoutSeconds,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          imagePullSecrets: args.imagePullSecrets,
          tolerations: args.tolerations,
          initContainers: [
            {
              name: 'rclone',
              image: args.rcloneImage,
              command: [
                '/bin/sh',
                '-c',
                'cp "$(command -v rclone)" /flui/rclone',
              ],
              volumeMounts: [{ name: 'flui', mountPath: '/flui' }],
            },
          ],
          containers: [
            {
              name: 'dump',
              image: args.image,
              command: ['bash', '-c', args.script],
              env: args.env,
              envFrom: [
                ...args.envFrom,
                { secretRef: { name: args.secretName } },
              ],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { memory: '512Mi' },
              },
              volumeMounts: [{ name: 'flui', mountPath: '/flui' }],
            },
          ],
          volumes: [{ name: 'flui', emptyDir: {} }],
        },
      },
    },
  };
}
