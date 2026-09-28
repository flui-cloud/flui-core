import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';
import { NodeType } from '../entities/cluster-node.entity';
import { VNetSubnetEntity } from '../../vnets/entities/vnet-subnet.entity';
import { HostCommandService } from '../../../providers/core/host/host-command.service';
import { deriveMasterHostTarget } from '../../../providers/core/host/host-targets';
import {
  declaredNodeNetworks,
  isUsablePrivateCidr,
  readVnetSubnetRanges,
} from '../../../providers/core/host/cluster-private-networks';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { nfsAllowedNetworks } from './k3s-script.service';

export const SHARED_STORAGE_PATH = '/var/lib/flui/storage';
const EXPORTS_FILE = '/etc/exports';
const EXPORT_OPTIONS = 'rw,async,no_subtree_check,no_root_squash';
const SCRIPT_TIMEOUT_MS = 6 * 60_000;
const CERT_TTL_SECONDS = 600;

const OK = 'FLUI_NFS_EXPORT_OK';
const UPDATED = 'FLUI_NFS_EXPORT_UPDATED';
const UNCHANGED = 'FLUI_NFS_EXPORT_UNCHANGED';
const ABSENT = 'FLUI_NFS_EXPORT_ABSENT';
const NO_SERVER = 'FLUI_NFS_EXPORT_NO_SERVER';
const ROLLED_BACK = 'FLUI_NFS_EXPORT_ROLLBACK';

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;

function isPrivateIpv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

export type SharedStorageExportState =
  | 'applied'
  | 'removed'
  | 'not-present'
  | 'blocked'
  | 'failed';

/** What `infrastructure_clusters.metadata.sharedStorageExport` holds. */
export interface SharedStorageExportRecord {
  state: SharedStorageExportState;
  networks: string[];
  fingerprint: string | null;
  reason: string | null;
  appliedAt: string | null;
  lastAttemptAt: string;
}

/**
 * Who may mount the master's shared storage: the cluster's private subnets,
 * the networks an operator declared for a BYOS cluster, the private addresses
 * of BYOS nodes, and the internal pod range. Never "anyone" — the export runs
 * with no_root_squash — and nothing at all when no private network is known.
 */
export function sharedStorageExportNetworks(input: {
  subnetRanges?: string[];
  declaredNodeNetworks?: string[];
  nodePrivateIps?: string[];
}): string[] {
  const hosts = (input.nodePrivateIps ?? [])
    .map((ip) => ip?.trim())
    .filter((ip): ip is string => !!ip && isPrivateIpv4(ip))
    .map((ip) => `${ip}/32`);
  const networks = [
    ...(input.subnetRanges ?? []),
    ...(input.declaredNodeNetworks ?? []),
    ...hosts,
  ]
    .map((n) => n?.trim())
    .filter((n): n is string => isUsablePrivateCidr(n));
  const joined = nfsAllowedNetworks(
    [...new Set(networks)].sort((x, y) => x.localeCompare(y)),
  );
  return joined ? joined.split(',') : [];
}

export function sharedStorageExportLine(
  networks: string[],
  sharePath = SHARED_STORAGE_PATH,
): string {
  if (!networks.length) return '';
  const clients = networks.map((n) => n + '(' + EXPORT_OPTIONS + ')');
  return `${sharePath} ${clients.join(' ')}`;
}

/**
 * Rewrites the shared storage line of `/etc/exports` and re-exports, putting
 * the previous file back when the new list is refused.
 *
 * Touches only the line for the shared path: whatever else the operator
 * exports from this machine is theirs. An empty list removes the line.
 * Refusals exit 0 with a marker, because a non-zero exit reaches the API as
 * stderr alone and the reason would be lost.
 */
export function buildSharedStorageExportScript(
  networks: string[],
  paths: { exportsFile?: string; sharePath?: string } = {},
): string {
  const exportsFile = paths.exportsFile ?? EXPORTS_FILE;
  const sharePath = paths.sharePath ?? SHARED_STORAGE_PATH;
  const line = sharedStorageExportLine(networks, sharePath);
  return [
    'set -e',
    `EXPORTS='${exportsFile}'`,
    `SHARE='${sharePath}'`,
    `LINE='${line}'`,
    `if [ ! -d "$SHARE" ]; then echo ${ABSENT}; echo ${OK}; exit 0; fi`,
    'CURRENT=$(awk -v p="$SHARE" \'$1==p\' "$EXPORTS" 2>/dev/null || true)',
    `if [ "$CURRENT" = "$LINE" ]; then echo ${UNCHANGED}; echo ${OK}; exit 0; fi`,
    'EXPORTFS=$(command -v exportfs 2>/dev/null || true)',
    'if [ -z "$EXPORTFS" ] && [ -x /usr/sbin/exportfs ]; then EXPORTFS=/usr/sbin/exportfs; fi',
    'if [ -z "$EXPORTFS" ] && [ -n "$LINE" ]; then',
    '  if command -v apt-get >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=180 install -yq nfs-kernel-server >/dev/null 2>&1; then',
    '    EXPORTFS=$(command -v exportfs 2>/dev/null || echo /usr/sbin/exportfs)',
    '  else',
    `    echo ${NO_SERVER}; exit 0`,
    '  fi',
    'fi',
    'touch "$EXPORTS"',
    'cp -p "$EXPORTS" "$EXPORTS.flui-bak"',
    'awk -v p="$SHARE" \'$1!=p\' "$EXPORTS.flui-bak" > "$EXPORTS.flui-tmp"',
    String.raw`if [ -n "$LINE" ]; then printf '%s\n' "$LINE" >> "$EXPORTS.flui-tmp"; fi`,
    'cat "$EXPORTS.flui-tmp" > "$EXPORTS"',
    'rm -f "$EXPORTS.flui-tmp"',
    'restore() {',
    '  cat "$EXPORTS.flui-bak" > "$EXPORTS"',
    '  "$EXPORTFS" -ra >/dev/null 2>&1 || true',
    '  rm -f "$EXPORTS.flui-bak"',
    '}',
    'if [ -n "$EXPORTFS" ]; then',
    '  if [ -n "$LINE" ]; then systemctl enable --now nfs-server >/dev/null 2>&1 || true; fi',
    '  if ! ERR=$("$EXPORTFS" -ra 2>&1); then',
    '    restore',
    String.raw`    echo "${ROLLED_BACK}: $(printf '%s' "$ERR" | tail -n 3 | tr '\n' ' ')"; exit 0`,
    '  fi',
    '  if [ -n "$LINE" ] && ! "$EXPORTFS" -v 2>/dev/null | awk -v p="$SHARE" \'$1==p{f=1} END{exit !f}\'; then',
    '    restore',
    `    echo "${ROLLED_BACK}: the shared path is not exported after the rewrite"; exit 0`,
    '  fi',
    'fi',
    'rm -f "$EXPORTS.flui-bak"',
    `echo ${UPDATED}`,
    `echo ${OK}`,
  ].join('\n');
}

export function sharedStorageExportRecordOf(
  cluster: Pick<ClusterEntity, 'metadata'>,
): SharedStorageExportRecord | undefined {
  const raw = (
    cluster.metadata as {
      sharedStorageExport?: SharedStorageExportRecord;
    } | null
  )?.sharedStorageExport;
  return raw && typeof raw === 'object' ? raw : undefined;
}

export interface SharedStorageExportOutcome {
  skipped?: 'disabled' | 'not-ready' | 'unchanged';
  record?: SharedStorageExportRecord;
}

/**
 * Keeps the master's shared storage export limited to the networks Flui knows
 * for the cluster.
 *
 * The bootstrap writes the export once, from what was known then: a BYOS
 * cluster learns its node network only when a node joins, and masters built
 * before the export was restricted still offer the volume to anyone. Same
 * mechanism as the telemetry rewrite — an idempotent script over a short SSH
 * session, no agent on the node — and the outcome is written on the cluster
 * so a refusal is visible rather than silent.
 */
@Injectable()
export class SharedStorageExportReconciler {
  private readonly logger = new Logger(SharedStorageExportReconciler.name);
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(VNetSubnetEntity)
    private readonly subnetRepository: Repository<VNetSubnetEntity>,
    private readonly hostCommand: HostCommandService,
  ) {}

  /** Runs in the background after an event; the outcome lands on the cluster. */
  reconcileSoon(clusterId: string, why: string): void {
    this.reconcile(clusterId).catch((err) =>
      this.logger.warn(
        `[shared-storage] export of ${clusterId} not reconciled after ${why}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );
  }

  /** Serialised per cluster: two rewrites of the same file must not interleave. */
  reconcile(
    clusterId: string,
    options: { force?: boolean } = {},
  ): Promise<SharedStorageExportOutcome> {
    const previous = this.inFlight.get(clusterId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.reconcileNow(clusterId, options));
    this.inFlight.set(clusterId, next);
    return next.finally(() => {
      if (this.inFlight.get(clusterId) === next)
        this.inFlight.delete(clusterId);
    });
  }

  async desiredNetworks(cluster: ClusterEntity): Promise<string[]> {
    const { ranges, error } = await readVnetSubnetRanges(
      cluster,
      this.subnetRepository,
    );
    if (error) {
      throw new Error(`the private network could not be read (${error})`);
    }
    const byos = cluster.provider === CloudProvider.BYOS;
    return sharedStorageExportNetworks({
      subnetRanges: ranges,
      declaredNodeNetworks: byos ? declaredNodeNetworks(cluster) : [],
      nodePrivateIps: byos
        ? (cluster.nodes ?? []).map((n) => n.privateIp ?? '')
        : [],
    });
  }

  private async reconcileNow(
    clusterId: string,
    options: { force?: boolean },
  ): Promise<SharedStorageExportOutcome> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) return { skipped: 'not-ready' };
    if (cluster.sharedStorageEnabled === false) return { skipped: 'disabled' };
    if (
      cluster.status === ClusterStatus.DELETING ||
      cluster.status === ClusterStatus.DELETED
    )
      return { skipped: 'not-ready' };

    const previous = sharedStorageExportRecordOf(cluster);
    let networks: string[];
    try {
      networks = await this.desiredNetworks(cluster);
    } catch (err) {
      return {
        record: await this.record(cluster, {
          state: 'failed',
          networks: previous?.networks ?? [],
          fingerprint: null,
          reason: `The shared storage access list was not updated: ${
            err instanceof Error ? err.message : String(err)
          }.`,
        }),
      };
    }

    const workers = (cluster.nodes ?? []).filter(
      (n) => n.nodeType !== NodeType.MASTER,
    );
    const script = buildSharedStorageExportScript(networks);
    const fingerprint = createHash('sha256')
      .update(`${workers.length > 0 ? 'multi' : 'single'}\n${script}`)
      .digest('hex')
      .slice(0, 32);

    if (
      !options.force &&
      previous?.fingerprint === fingerprint &&
      previous.state !== 'failed'
    ) {
      return { skipped: 'unchanged', record: previous };
    }

    if (!networks.length && workers.length > 0) {
      return {
        record: await this.record(cluster, {
          state: 'blocked',
          networks: [],
          fingerprint,
          reason:
            'Flui does not know the private network of this cluster, so the ' +
            'shared storage access list was left as it is: narrowing it now ' +
            'would cut the other nodes off from the shared storage.',
        }),
      };
    }

    let out: string;
    let target: string | undefined;
    try {
      const host = deriveMasterHostTarget(cluster);
      target = `${host.host}:${host.port}`;
      out = await this.hostCommand.run(host, script, {
        timeoutMs: SCRIPT_TIMEOUT_MS,
        certTtlSeconds: CERT_TTL_SECONDS,
      });
    } catch (err) {
      return {
        record: await this.record(cluster, {
          state: 'failed',
          networks,
          fingerprint,
          reason: describeRunFailure(err, target),
        }),
      };
    }

    return {
      record: await this.record(
        cluster,
        this.interpret(out, networks, fingerprint, previous),
      ),
    };
  }

  private interpret(
    out: string,
    networks: string[],
    fingerprint: string,
    previous: SharedStorageExportRecord | undefined,
  ): Omit<SharedStorageExportRecord, 'lastAttemptAt'> {
    const base = { networks, fingerprint };
    if (out.includes(ABSENT)) {
      return {
        ...base,
        state: 'not-present',
        reason:
          'The main node of this cluster has no shared storage, so there is nothing to share.',
        appliedAt: null,
      };
    }
    if (out.includes(NO_SERVER)) {
      return {
        ...base,
        state: 'failed',
        reason:
          'The service that shares storage between nodes is not installed on the ' +
          'main node and could not be installed.',
        appliedAt: null,
      };
    }
    if (out.includes(ROLLED_BACK)) {
      const detail = (out.split(`${ROLLED_BACK}:`)[1] ?? '')
        .split('\n')[0]
        .trim();
      return {
        ...base,
        state: 'failed',
        reason:
          'The new shared storage access list was refused and the previous one ' +
          'was put back' +
          (detail ? ': ' + detail : '') +
          '.',
        appliedAt: null,
      };
    }
    if (!out.includes(OK)) {
      return {
        ...base,
        state: 'failed',
        reason: `The shared storage access list update did not confirm: ${out.trim().slice(-200)}`,
        appliedAt: null,
      };
    }
    const unchanged = out.includes(UNCHANGED) && !out.includes(UPDATED);
    return {
      ...base,
      state: networks.length ? 'applied' : 'removed',
      reason: networks.length
        ? null
        : 'No other node needs the shared storage and Flui knows no private ' +
          'network for this cluster, so it is not shared.',
      appliedAt:
        unchanged && previous?.appliedAt
          ? previous.appliedAt
          : new Date().toISOString(),
    };
  }

  /** Merged onto the freshest metadata so a concurrent write is not undone. */
  private async record(
    cluster: ClusterEntity,
    record: Omit<SharedStorageExportRecord, 'lastAttemptAt' | 'appliedAt'> & {
      appliedAt?: string | null;
    },
  ): Promise<SharedStorageExportRecord> {
    const previous = sharedStorageExportRecordOf(cluster);
    const { appliedAt = previous?.appliedAt ?? null } = record;
    const full: SharedStorageExportRecord = {
      ...record,
      appliedAt,
      lastAttemptAt: new Date().toISOString(),
    };
    if (full.state === 'failed' || full.state === 'blocked') {
      this.logger.warn(
        `[shared-storage] ${cluster.name}: ${full.state} — ${full.reason}`,
      );
    } else if (full.appliedAt !== previous?.appliedAt) {
      this.logger.log(
        `[shared-storage] ${cluster.name}: export ${full.state} (${
          full.networks.join(', ') || 'none'
        })`,
      );
    }
    try {
      const fresh = await this.clusterRepository.findOne({
        where: { id: cluster.id },
      });
      const metadata: ClusterEntity['metadata'] = {
        ...(fresh ?? cluster).metadata,
        sharedStorageExport: { ...full },
      };
      await this.clusterRepository.update(cluster.id, { metadata });
    } catch (err) {
      this.logger.warn(
        `[shared-storage] could not record the export state of ${cluster.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return full;
  }
}

function describeRunFailure(err: unknown, target: string | undefined): string {
  if (err instanceof ServiceUnavailableException) {
    const where = target ? ' (' + target + ')' : '';
    return (
      `The main node${where} could not be reached to update the shared ` +
      `storage access list: ${err.message}`
    );
  }
  const message =
    err instanceof Error
      ? err.message
      : String(err as string | number | boolean | null | undefined);
  return `The shared storage access list could not be updated on the main node: ${message}`;
}
