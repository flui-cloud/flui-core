import {
  CNPG_API_VERSION,
  CNPG_POSTGRES_IMAGE,
} from '../postgres-ha.constants';
import { CnpgClusterInput, renderCnpgCluster } from './cnpg-cluster.core';

/**
 * Moving a single Postgres into a highly available one without stopping its
 * application, in this order: the copy streams from
 * the running instance, the instance turns read-only, the copy catches up and
 * is promoted, and the application's address moves to the new primary. Writes
 * pause for about ten seconds and no confirmed write is lost.
 */

export const HA_REPLICATION_ROLE = 'flui_ha_repl';
export const HA_HBA_MARKER = 'flui-ha-copy';
const EXTERNAL_SOURCE = 'flui-single';
const OCTET_RE = /^\d{1,3}$/;

function isIpv4Cidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split('/');
  if (rest.length || !prefix || !/^\d{1,2}$/.test(prefix)) return false;
  const octets = address.split('.');
  return (
    octets.length === 4 &&
    octets.every((o) => OCTET_RE.test(o) && Number(o) <= 255) &&
    Number(prefix) <= 32
  );
}

/**
 * The roles the operator expects in the data it copies. Flui's own image makes
 * the application's user the superuser and has no `postgres`, which the
 * operator's agent connects as; without it the copy never leaves its first
 * instance.
 */
export function sourceRolesSql(replicationPasswordLiteral: string): string[] {
  return [
    `DO $$ BEGIN CREATE ROLE postgres WITH SUPERUSER LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `DO $$ BEGIN CREATE ROLE streaming_replica WITH REPLICATION LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `DO $$ BEGIN CREATE ROLE ${HA_REPLICATION_ROLE} WITH REPLICATION LOGIN PASSWORD ${replicationPasswordLiteral}; EXCEPTION WHEN duplicate_object THEN ALTER ROLE ${HA_REPLICATION_ROLE} WITH PASSWORD ${replicationPasswordLiteral}; END $$`,
  ];
}

/** Lets the copy stream from inside the cluster's pod network, and nothing else. */
export function copyHbaScript(podNetwork: string): string {
  if (!isIpv4Cidr(podNetwork)) {
    throw new Error(`Not a pod network range: ${podNetwork}`);
  }
  const begin = `# ${HA_HBA_MARKER}:begin`;
  const end = `# ${HA_HBA_MARKER}:end`;
  return [
    'set -e',
    'HBA="$PGDATA/pg_hba.conf"',
    `if ! grep -qx '${begin}' "$HBA"; then`,
    String.raw`  { printf '${begin}\nhost replication ${HA_REPLICATION_ROLE} ${podNetwork} scram-sha-256\n${end}\n'`,
    '    cat "$HBA"; } > "$HBA.flui" && cat "$HBA.flui" > "$HBA" && rm -f "$HBA.flui"',
    'fi',
  ].join('\n');
}

/** The source stops taking writes; sessions already open are ended so none slips through. */
export function fenceSql(): string[] {
  return [
    'ALTER SYSTEM SET default_transaction_read_only = on',
    'SELECT pg_reload_conf()',
    `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()`,
    'SELECT pg_switch_wal()',
    'SELECT pg_current_wal_lsn()',
  ];
}

/** Undoes the fence, for a move that is abandoned before the copy is promoted. */
export function unfenceSql(): string[] {
  return [
    'ALTER SYSTEM RESET default_transaction_read_only',
    'SELECT pg_reload_conf()',
  ];
}

export function caughtUpSql(sourceLsn: string): string {
  if (!/^[0-9A-F]+\/[0-9A-F]+$/i.test(sourceLsn)) {
    throw new Error(`Not a WAL position: ${sourceLsn}`);
  }
  return `SELECT pg_last_wal_replay_lsn() >= '${sourceLsn}'::pg_lsn`;
}

export interface CopyClusterInput
  extends Omit<CnpgClusterInput, 'database' | 'owner' | 'credentialsSecret'> {
  /**
   * A basic-auth secret for `postgres`. Without one the operator removes that
   * role's password when the copy is promoted, and an application that signs
   * in as `postgres` is locked out.
   */
  superuserSecret?: string;
  /** The source's in-cluster address, the application's own Service. */
  sourceHost: string;
  replicationSecret: string;
}

/**
 * The highly available cluster as a streaming copy of the running instance.
 * It keeps the source's data, users and passwords, so the application's
 * credentials keep working once it is promoted.
 */
export function renderCnpgCopyCluster(
  input: CopyClusterInput,
): Record<string, unknown> {
  const base = renderCnpgCluster({
    ...input,
    database: 'unused',
    owner: 'unused',
    credentialsSecret: 'unused',
  });
  const spec = { ...(base.spec as Record<string, unknown>) };
  delete spec.bootstrap;
  return {
    ...base,
    apiVersion: CNPG_API_VERSION,
    spec: {
      ...spec,
      imageName: input.imageName ?? CNPG_POSTGRES_IMAGE,
      ...(input.superuserSecret && {
        enableSuperuserAccess: true,
        superuserSecret: { name: input.superuserSecret },
      }),
      bootstrap: { pg_basebackup: { source: EXTERNAL_SOURCE } },
      replica: { enabled: true, source: EXTERNAL_SOURCE },
      externalClusters: [
        {
          name: EXTERNAL_SOURCE,
          connectionParameters: {
            host: input.sourceHost,
            user: HA_REPLICATION_ROLE,
            dbname: 'postgres',
            sslmode: 'disable',
          },
          password: { name: input.replicationSecret, key: 'password' },
        },
      ],
    },
  };
}

export function promotionPatch(): Record<string, unknown> {
  return { spec: { replica: { enabled: false } } };
}

/** Where the application's Service points once the copy is its primary. */
export function primarySelectorPatch(
  appSlug: string,
  clusterName: string,
): Record<string, unknown> {
  return {
    spec: {
      selector: {
        app: null,
        'cnpg.io/cluster': clusterName,
        'cnpg.io/instanceRole': 'primary',
      },
    },
    metadata: { annotations: { 'flui.cloud/ha-previous-selector': appSlug } },
  };
}

/**
 * The copies carry the application's id as well, and the one acting as
 * primary is picked before any other pod: while the copy is being built, the
 * single instance has to be named apart from them.
 */
export function singleInstanceSelector(appSelector: string): string {
  return `${appSelector},!cnpg.io/cluster`;
}
