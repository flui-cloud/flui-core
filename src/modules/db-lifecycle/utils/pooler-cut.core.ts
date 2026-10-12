import {
  POOLER_OF_LABEL,
  POOLER_ROLE,
  assertPgbouncerName,
} from '../../applications/utils/db-pooler.core';
import { ShowRow } from '../../database-console/engine/pgbouncer-show.core';
import { clusterInternalCidrs } from '../../infrastructure/egress/egress-policy.core';
import type { ApplicationEntity } from '../../applications/entities/application.entity';
import type {
  DbPoolerCutEntry,
  DbPoolerCutRecord,
  PoolerCutRole,
} from '../entities/db-migration.entity';

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function assertIp(ip: string): void {
  if (!IPV4_RE.test(ip)) throw new Error(`Not an overlay address: ${ip}`);
}

export const DEFAULT_PAUSE_DEADLINE_MS = 5_000;
export const MIN_PAUSE_DEADLINE_MS = 1_000;
export const MAX_PAUSE_DEADLINE_MS = 60_000;
export const PAUSE_POLL_MS = 200;
export const PAUSE_CONFIRM_MS = 5_000;
export const RESUME_QUEUE_MS = 30_000;
export const CUT_SETTLE_MS = 5_000;
const FENCE_VERIFY_MS = 10_000;
const PROMOTE_MS = 60_000;
const RETARGET_MS = 15_000;
const WAIT_MARGIN_S = 30;
/** The longest a client may be held in a paused pooler's queue. */
export const MAX_QUERY_WAIT_S = 600;
export { POOLER_LOGIN_TIMEOUT_DEFAULT_S } from '../../applications/utils/db-pooler.core';

export function pauseDeadlineMs(seconds?: number | null): number {
  if (seconds === undefined || seconds === null) {
    return DEFAULT_PAUSE_DEADLINE_MS;
  }
  const ms = Math.round(seconds * 1000);
  if (
    !Number.isFinite(ms) ||
    ms < MIN_PAUSE_DEADLINE_MS ||
    ms > MAX_PAUSE_DEADLINE_MS
  ) {
    throw new Error(
      `The pause deadline must be between ${MIN_PAUSE_DEADLINE_MS / 1000} and ${MAX_PAUSE_DEADLINE_MS / 1000} seconds`,
    );
  }
  return ms;
}

/** How long clients may wait in the paused queue, from the pause to the resume. */
export function pauseBudgetMs(deadlineMs: number, drainMs: number): number {
  return deadlineMs + FENCE_VERIFY_MS + drainMs + PROMOTE_MS + RETARGET_MS;
}

/**
 * The client wait the pooler is raised to for the pause, in seconds. A budget
 * the pooler would not hold is refused before anything stops.
 */
export function pauseWaitSeconds(
  budgetMs: number,
  maxS = MAX_QUERY_WAIT_S,
): number {
  const s = Math.ceil(budgetMs / 1000) + WAIT_MARGIN_S;
  if (s > maxS) {
    throw new Error(
      `A write pause of up to ${Math.ceil(budgetMs / 1000)}s does not fit the ${maxS}s a pooled client may wait; lower the pause deadline`,
    );
  }
  return s;
}

export function raiseWaitCommands(waitS: number): string[] {
  return [
    `SET query_wait_timeout = ${waitS};`,
    `SET client_login_timeout = ${waitS};`,
  ];
}

/** The configuration file holds the timeouts the pooler runs with outside a pause. */
export const RESTORE_WAIT_COMMANDS = ['RELOAD;'];

/** The admin console reads a name with a dash only between double quotes. */
const adminName = (database: string): string =>
  `"${assertPgbouncerName('database name', database)}"`;

export const pauseCommand = (database: string): string =>
  `PAUSE ${adminName(database)};`;
export const killCommand = (database: string): string =>
  `KILL ${adminName(database)};`;
export const resumeCommand = (database: string): string =>
  `RESUME ${adminName(database)};`;

/** Server connections the pooler still holds to the database, its admin console aside. */
export function heldServers(servers: ShowRow[]): ShowRow[] {
  return servers.filter((s) => s.database !== 'pgbouncer');
}

/** `2026-10-12 10:00:01 UTC` as PgBouncer prints it. */
export function pgbouncerTime(value: string | undefined): number | null {
  if (!value) return null;
  const iso = value.trim().replace(' ', 'T').replace(/ UTC$/, 'Z');
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Who still held a server connection at the deadline: each held server, with
 * the client linked to it when there is one. `heldMs` counts from the client's
 * latest request, the closest PgBouncer comes to the start of the transaction.
 */
export function cutSnapshot(
  pod: string,
  role: PoolerCutRole,
  servers: ShowRow[],
  clients: ShowRow[],
  at: Date,
): DbPoolerCutEntry[] {
  const clientByPtr = new Map(
    clients.filter((c) => c.ptr).map((c) => [c.ptr, c] as const),
  );
  return heldServers(servers).map((s) => {
    const client = s.link ? clientByPtr.get(s.link) : undefined;
    const since = pgbouncerTime(client?.request_time ?? s.request_time);
    const pid = Number.parseInt(s.remote_pid ?? '', 10);
    const id = Number.parseInt(client?.id ?? '', 10);
    return {
      pod,
      role,
      remotePid: Number.isFinite(pid) ? pid : null,
      clientId: Number.isFinite(id) ? id : null,
      user: s.user ?? '',
      database: s.database ?? '',
      clientAddr: client?.addr ?? null,
      clientApp:
        (client?.application_name ?? '').replace(/ - [^ ]+:\d+$/, '') || null,
      heldMs: since === null ? null : Math.max(0, at.getTime() - since),
    };
  });
}

/**
 * The `pg_hba.conf` block that admits the destination pooler's forwarded
 * sessions from the destination node's overlay address. It goes on top; the
 * fence, prepended later, still sits above it and rejects everything.
 */
export function forwardHbaScript(
  marker: string,
  database: string,
  dstOverlayIp: string,
): string {
  assertIp(dstOverlayIp);
  const db = assertPgbouncerName('database name', database);
  const begin = `# ${marker}:begin`;
  const end = `# ${marker}:end`;
  return [
    'set -e',
    'HBA="$PGDATA/pg_hba.conf"',
    `if ! grep -qx '${begin}' "$HBA"; then`,
    String.raw`  { printf '${begin}\nhost ${db} all ${dstOverlayIp}/32 scram-sha-256\n${end}\n'`,
    '    cat "$HBA"; } > "$HBA.flui" && chown postgres:postgres "$HBA.flui" && chmod 600 "$HBA.flui" && mv "$HBA.flui" "$HBA"',
    'fi',
  ].join('\n');
}

/**
 * The destination's pooler pods may dial the source's overlay endpoint. Once a
 * policy selects a pod for egress, everything it does not list is closed, so
 * DNS and the cluster's own addresses stay open beside the endpoint.
 */
export function forwardEgressManifest(
  namespace: string,
  dstAppId: string,
  name: string,
  overlayIp: string,
  port: number,
  internalCidrs: string[] = clusterInternalCidrs(),
): string {
  assertIp(overlayIp);
  return [
    'apiVersion: networking.k8s.io/v1',
    'kind: NetworkPolicy',
    'metadata:',
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    '  labels:',
    '    app.kubernetes.io/managed-by: flui',
    `    ${POOLER_OF_LABEL}: ${dstAppId}`,
    'spec:',
    '  podSelector:',
    '    matchLabels:',
    `      ${POOLER_OF_LABEL}: ${dstAppId}`,
    '  policyTypes:',
    '    - Egress',
    '  egress:',
    '    - to:',
    '        - ipBlock:',
    `            cidr: ${overlayIp}/32`,
    '      ports:',
    '        - protocol: TCP',
    `          port: ${port}`,
    '    - to:',
    '        - namespaceSelector:',
    '            matchLabels:',
    '              kubernetes.io/metadata.name: kube-system',
    '      ports:',
    '        - protocol: UDP',
    '          port: 53',
    '        - protocol: TCP',
    '          port: 53',
    '    - to:',
    ...internalCidrs.flatMap((cidr) => [
      '        - ipBlock:',
      `            cidr: ${cidr}`,
    ]),
  ].join('\n');
}

const USERLIST = '/etc/pgbouncer/userlist.txt';

/**
 * Asks, from inside a pooler pod and through the Service the pooler dials,
 * which database answers. The pooler's own password is read from the user
 * list it mounts; nothing secret rides the exec request.
 */
export function whoamiProbeScript(
  upstreamHost: string,
  database: string,
): string {
  const db = assertPgbouncerName('database name', database);
  if (!/^[a-z0-9.-]+$/.test(upstreamHost)) {
    throw new Error(`Not a service host: ${upstreamHost}`);
  }
  return [
    'set -e',
    String.raw`PGPASSWORD="$(sed -n 's/^"${POOLER_ROLE}" "\(.*\)"$/\1/p' ${USERLIST})"`,
    'export PGPASSWORD',
    `psql -X -A -t -F '|' -v ON_ERROR_STOP=1 "host=${upstreamHost} port=5432 dbname=${db} user=${POOLER_ROLE} sslmode=prefer connect_timeout=3" -c "SELECT in_recovery, system_identifier, timeline_id, host(server_addr) FROM ${POOLER_ROLE}.whoami();"`,
  ].join('\n');
}

export interface Whoami {
  inRecovery: boolean;
  systemIdentifier: string;
  timeline: number;
  serverAddr: string | null;
}

export function parseWhoami(out: string): Whoami | null {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.split('|').length >= 4);
  if (!line) return null;
  const [rec, sysid, tli, addr] = line.split('|');
  const timeline = Number.parseInt(tli, 10);
  if ((rec !== 't' && rec !== 'f') || !sysid || !Number.isFinite(timeline)) {
    return null;
  }
  return {
    inRecovery: rec === 't',
    systemIdentifier: sysid,
    timeline,
    serverAddr: addr || null,
  };
}

/** Forwarding reaches the source: a primary, same identity, the source's timeline. */
export function forwardsToSource(
  seen: Whoami | null,
  source: { systemIdentifier: string; timeline: number },
): boolean {
  return (
    !!seen &&
    !seen.inRecovery &&
    seen.systemIdentifier === source.systemIdentifier &&
    seen.timeline === source.timeline
  );
}

/**
 * Back on the destination after the promote: a primary with the same identity
 * that is not the source, told apart by the next timeline or by the address of
 * the destination's own database pod.
 */
export function reachesPromotedDestination(
  seen: Whoami | null,
  expected: {
    systemIdentifier: string;
    sourceTimeline: number | null;
    dstPodIp: string | null;
  },
): boolean {
  if (!seen || seen.inRecovery) return false;
  if (seen.systemIdentifier !== expected.systemIdentifier) return false;
  if (expected.dstPodIp && seen.serverAddr === expected.dstPodIp) return true;
  return (
    expected.sourceTimeline !== null &&
    seen.timeline === expected.sourceTimeline + 1
  );
}

/** What a new pause starts from: the plan, none of an earlier attempt's pause. */
export function freshPauseRecord(plan: DbPoolerCutRecord): DbPoolerCutRecord {
  return {
    poolers: plan.poolers,
    deadlineMs: plan.deadlineMs,
    ...(plan.sourceSystemIdentifier !== undefined
      ? { sourceSystemIdentifier: plan.sourceSystemIdentifier }
      : {}),
    ...(plan.sourceTimeline !== undefined
      ? { sourceTimeline: plan.sourceTimeline }
      : {}),
  };
}

/** The destination's pooler: paused, and never resumed yet. */
export function pausedAndOpen(
  cut: DbPoolerCutRecord | null | undefined,
): boolean {
  return !!cut?.pausedAt && !cut.resumedAt;
}

export function hasPoolerPlan(
  cut: DbPoolerCutRecord | null | undefined,
): cut is DbPoolerCutRecord {
  return !!cut?.poolers?.length;
}

/** A pooled source and a pooled destination: the only case the pooler cut handles. */
export function poolerCutApplies(
  src: Pick<ApplicationEntity, 'pooler'> | null | undefined,
  dst: Pick<ApplicationEntity, 'pooler'> | null | undefined,
): boolean {
  return (
    !!src?.pooler?.enabled &&
    !!src.pooler.routed &&
    !src.pooler.suspended &&
    !!dst?.pooler?.enabled
  );
}
