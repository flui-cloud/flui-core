import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { DnsProviderFactory } from '../../providers/core/factories/dns-provider.factory';
import {
  DnsRecordInfo,
  DnsRecordType,
  IDnsProvider,
} from '../../providers/interfaces/dns-provider.interface';
import { DnsProvider } from '../../providers/enums/dns-provider.enum';
import { DnsZoneEntity } from '../entities/dns-zone.entity';
import { DnsZoneReplicaEntity } from '../entities/dns-zone-replica.entity';
import { ClusterDnsZoneEntity } from '../entities/cluster-dns-zone.entity';
import { DnsReplicaStatus } from '../enums/dns-replica-status.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { resolveRecordName } from '../utils/resolve-record-name.util';
import { sharedWildcardRecordName } from '../utils/shared-subdomain.util';
import { SandboxSubdomainConfigService } from './sandbox-subdomain-config.service';

export interface ExpectedDnsRecord {
  name: string;
  type: DnsRecordType;
  value: string;
  ttl: number;
}

/**
 * Whether the one record that makes a cluster's applications resolve instantly
 * is in place — and, when it is not, which of the reasons it is.
 *
 * `foreign` and `absent` are deliberately different: one is somebody else's
 * record that Flui will not touch, the other is work waiting to be done. An
 * interface that showed both as "not configured" would invite an operator to
 * press a button that is going to refuse.
 */
export interface ClusterWildcardStatus {
  status: 'published' | 'absent' | 'foreign' | 'unknown' | 'unavailable';
  /** `*.<cluster>.<zone>`, or null before the cluster has an address. */
  fqdn: string | null;
  /** The same thing said the way a person reads it. */
  hostnamePattern: string | null;
  expectedValue: string | null;
  actualValue: string | null;
}

/**
 * The one record that covers every application a cluster publishes under a
 * zone: `*.<cluster>` → the cluster's address.
 *
 * Derived, never configured, because the hostname rule it mirrors is itself
 * derived — `generateFqdn` builds `<slug>.<cluster.name>.<zone>` and nothing
 * else. Scoped to the cluster's own subdomain rather than the zone root, so it
 * can only ever answer for names Flui would have created itself: a zone shared
 * with a website and a mail server is untouched outside `*.<cluster>`.
 */
export function clusterWildcardRecord(
  assignment: ClusterDnsZoneEntity,
  zone: DnsZoneEntity,
): ExpectedDnsRecord | null {
  const clusterName = assignment.cluster?.name;
  const value = assignment.cluster?.masterIpAddress;
  if (!clusterName || !value) return null;
  return {
    name: `*.${clusterName}`,
    type: DnsRecordType.A,
    value,
    ttl: zone.recordTtlSeconds,
  };
}

/**
 * `*.<label>` → the sandbox cluster's address: the one record under which every
 * application of every sandbox tenancy resolves.
 *
 * Separate from `clusterWildcardRecord` because it answers for a different
 * space and only on one cluster. It has to be in the expected set for the same
 * reason that one does: it is an A record pointing at a cluster master IP that
 * no endpoint claims, which is precisely what the orphan sweep deletes.
 */
export function sandboxWildcardRecord(
  assignment: ClusterDnsZoneEntity,
  zone: DnsZoneEntity,
  label: string,
): ExpectedDnsRecord | null {
  const value = assignment.cluster?.masterIpAddress;
  const name = sharedWildcardRecordName(label);
  if (!value || !name) return null;
  return {
    name,
    type: DnsRecordType.A,
    value,
    ttl: zone.recordTtlSeconds,
  };
}

/** What a zone SHOULD contain, derived purely from Flui state (no provider labels). */
export interface ZoneReconcilePlan {
  zoneName: string;
  expected: ExpectedDnsRecord[];
  clusterMasterIps: Set<string>;
}

export interface ReplicaDiffReport {
  provider: DnsProvider;
  providerZoneId: string;
  created: number;
  updated: number;
  orphansDeleted: number;
  mismatches: Array<{
    name: string;
    type: string;
    expected: string;
    actual: string;
  }>;
  errors: string[];
}

/** Replica statuses that receive fan-out writes and are reconciled by the cron. */
const FANOUT_ELIGIBLE: DnsReplicaStatus[] = [
  DnsReplicaStatus.POPULATING,
  DnsReplicaStatus.ACTIVE,
  DnsReplicaStatus.DEGRADED,
];

/**
 * Publishes and reconciles the record content of a logical DNS zone across its
 * provider replicas. Flui is the source of truth: the expected record set is
 * built from AppEndpoints, never from provider labels, which also neutralises
 * the Scaleway no-label gap. Fan-out is best-effort — the primary write throws
 * (handled by the caller), replica failures mark the replica DEGRADED and the
 * cron heals; a failing replica never fails a deploy.
 */
@Injectable()
export class DnsZoneReconciliationService {
  private readonly logger = new Logger(DnsZoneReconciliationService.name);

  constructor(
    @InjectRepository(DnsZoneEntity)
    private readonly zoneRepo: Repository<DnsZoneEntity>,
    @InjectRepository(DnsZoneReplicaEntity)
    private readonly replicaRepo: Repository<DnsZoneReplicaEntity>,
    @InjectRepository(ClusterDnsZoneEntity)
    private readonly assignmentRepo: Repository<ClusterDnsZoneEntity>,
    private readonly dnsProviderFactory: DnsProviderFactory,
    private readonly sandboxSubdomain: SandboxSubdomainConfigService,
  ) {}

  // ── Fan-out (write path) ───────────────────────────────────────────────────

  /** Publish one record to every eligible replica. Never throws — a failing replica must not fail a deploy. */
  async fanOutRecordToReplicas(
    zone: DnsZoneEntity,
    rec: ExpectedDnsRecord,
  ): Promise<void> {
    for (const replica of await this.eligibleReplicasSafe(zone)) {
      try {
        const provider = this.dnsProviderFactory.getDnsProviderOrFail(
          replica.dnsProvider,
        );
        await this.upsertRecordByNameType(
          provider,
          replica.providerZoneId,
          rec,
        );
      } catch (err) {
        await this.markReplicaDegraded(replica, err);
      }
    }
  }

  /** Delete one record from every eligible replica. Never throws. */
  async fanOutDeleteToReplicas(
    zone: DnsZoneEntity,
    name: string,
    type: DnsRecordType,
  ): Promise<void> {
    for (const replica of await this.eligibleReplicasSafe(zone)) {
      try {
        const provider = this.dnsProviderFactory.getDnsProviderOrFail(
          replica.dnsProvider,
        );
        await this.deleteRecordByNameType(
          provider,
          replica.providerZoneId,
          name,
          type,
        );
      } catch (err) {
        await this.markReplicaDegraded(replica, err);
      }
    }
  }

  // ── Record-level upsert/delete keyed by (name, type) ───────────────────────

  async upsertRecordByNameType(
    provider: IDnsProvider,
    providerZoneId: string,
    rec: ExpectedDnsRecord,
  ): Promise<'created' | 'updated' | 'noop'> {
    const records = await provider.listRecords(providerZoneId);
    const match = records.find(
      (r) => r.name === rec.name && r.type === rec.type,
    );
    if (!match) {
      await provider.createRecord({
        zoneId: providerZoneId,
        type: rec.type,
        name: rec.name,
        value: rec.value,
        ttl: rec.ttl,
      });
      return 'created';
    }
    // A falsy actual TTL means the provider did not report one — don't churn on it.
    const ttlMismatch = !!match.ttl && match.ttl !== rec.ttl;
    if (match.value !== rec.value || ttlMismatch) {
      await provider.updateRecord({
        recordId: match.recordId,
        zoneId: providerZoneId,
        type: rec.type,
        name: rec.name,
        value: rec.value,
        ttl: rec.ttl,
      });
      return 'updated';
    }
    return 'noop';
  }

  /**
   * Publish the cluster's wildcard on the zone's own provider.
   *
   * Needed as its own call because the full zone reconcile only runs for zones
   * that have a replica — a single-provider zone never gets one, which is most
   * of them. This is the narrow version: one record, no orphan sweep.
   *
   * **Creates, never overwrites.** A wildcard already pointing somewhere else
   * is somebody's decision, and taking it over would silently redirect whatever
   * it was serving. Flui says so and leaves it; the endpoint reconciliation
   * then keeps writing per-app records, because a wildcard with a different
   * value is not coverage.
   */
  async ensureClusterWildcardRecord(
    assignment: ClusterDnsZoneEntity,
    zone: DnsZoneEntity,
  ): Promise<ClusterWildcardStatus> {
    const state = await this.inspectClusterWildcard(assignment, zone);
    if (state.status !== 'absent') {
      if (state.status === 'foreign') {
        this.logger.warn(
          `[dns-wildcard] ${state.fqdn} already points at ${state.actualValue}, not ${state.expectedValue} — leaving it alone; applications on this cluster keep their own records`,
        );
      }
      return state;
    }

    const wanted = clusterWildcardRecord(assignment, zone);
    if (!wanted) return state;

    const provider = this.dnsProviderFactory.getDnsProviderOrFail(
      zone.dnsProvider,
    );
    await provider.createRecord({
      zoneId: zone.providerZoneId,
      type: wanted.type,
      name: wanted.name,
      value: wanted.value,
      ttl: wanted.ttl,
      // Without these `cleanupClusterDnsRecords` cannot see it — it matches on
      // that pair — so the record outlives the cluster. A later cluster taking
      // the same name then finds its own wildcard already answering, from an
      // address somebody else released, and never publishes one.
      labels: {
        'managed-by': 'flui-cloud',
        'flui-resource-type': 'dns-record',
        'flui-cluster-id': assignment.clusterId,
      },
    });
    this.logger.log(
      `[dns-wildcard] published ${state.fqdn} → ${wanted.value}; applications on this cluster resolve the moment they are created`,
    );
    return { ...state, status: 'published' };
  }

  /**
   * The same look, without writing anything — what the interface shows.
   *
   * Read live from the provider rather than from a column: a record somebody
   * removed by hand would otherwise keep showing as published, and this is
   * precisely the screen where a person goes to find out whether it is.
   */
  async inspectClusterWildcard(
    assignment: ClusterDnsZoneEntity,
    zone: DnsZoneEntity,
  ): Promise<ClusterWildcardStatus> {
    const wanted = clusterWildcardRecord(assignment, zone);
    if (!wanted) {
      return {
        status: 'unavailable',
        fqdn: null,
        hostnamePattern: null,
        expectedValue: null,
        actualValue: null,
      };
    }

    const fqdn = `${wanted.name}.${zone.zoneName}`;
    const base = {
      fqdn,
      hostnamePattern: fqdn.replace('*.', '<application>.'),
      expectedValue: wanted.value,
    };

    try {
      const provider = this.dnsProviderFactory.getDnsProviderOrFail(
        zone.dnsProvider,
      );
      const records = await provider.listRecords(zone.providerZoneId);
      const existing = records.find(
        (r) => r.name === wanted.name && r.type === wanted.type,
      );
      if (!existing) return { ...base, status: 'absent', actualValue: null };
      return existing.value === wanted.value
        ? { ...base, status: 'published', actualValue: existing.value }
        : { ...base, status: 'foreign', actualValue: existing.value };
    } catch (err) {
      this.logger.warn(
        `[dns-wildcard] could not read ${zone.zoneName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ...base, status: 'unknown', actualValue: null };
    }
  }

  /**
   * Publish one wildcard record on the zone's own provider, whoever it covers
   * for.
   *
   * **Creates, never overwrites**, on the same reasoning as the cluster's own
   * wildcard: a name already pointing somewhere else is somebody's decision,
   * and taking it over would silently redirect whatever it was serving. Returns
   * what it found so the caller can say so.
   */
  async ensureWildcardRecord(
    zone: DnsZoneEntity,
    wanted: ExpectedDnsRecord,
  ): Promise<'published' | 'present' | 'foreign' | 'unknown'> {
    const provider = this.dnsProviderFactory.getDnsProviderOrFail(
      zone.dnsProvider,
    );

    let existing: DnsRecordInfo | undefined;
    try {
      const records = await provider.listRecords(zone.providerZoneId);
      existing = records.find(
        (r) => r.name === wanted.name && r.type === wanted.type,
      );
    } catch (err) {
      this.logger.warn(
        `[dns-wildcard] could not read ${zone.zoneName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'unknown';
    }

    if (existing) {
      if (existing.value === wanted.value) return 'present';
      this.logger.warn(
        `[dns-wildcard] ${wanted.name}.${zone.zoneName} already points at ${existing.value}, not ${wanted.value} — leaving it alone`,
      );
      return 'foreign';
    }

    await provider.createRecord({
      zoneId: zone.providerZoneId,
      type: wanted.type,
      name: wanted.name,
      value: wanted.value,
      ttl: wanted.ttl,
    });
    this.logger.log(
      `[dns-wildcard] published ${wanted.name}.${zone.zoneName} → ${wanted.value}`,
    );
    return 'published';
  }

  async deleteRecordByNameType(
    provider: IDnsProvider,
    providerZoneId: string,
    name: string,
    type: DnsRecordType,
  ): Promise<void> {
    const records = await provider.listRecords(providerZoneId);
    const match = records.find((r) => r.name === name && r.type === type);
    if (match) {
      await provider.deleteRecord(providerZoneId, match.recordId);
    }
  }

  // ── Reconciliation (cron / populate / verify) ──────────────────────────────

  /** The canonical record set for a zone, derived from Flui state only. */
  async buildExpectation(zone: DnsZoneEntity): Promise<ZoneReconcilePlan> {
    const assignments = await this.assignmentRepo.find({
      where: { dnsZoneId: zone.id },
      relations: ['cluster', 'endpoints'],
    });

    const expected = new Map<string, ExpectedDnsRecord>();
    const clusterMasterIps = new Set<string>();

    for (const assignment of assignments) {
      const masterIp = assignment.cluster?.masterIpAddress;
      if (masterIp) clusterMasterIps.add(masterIp);

      // The cluster's own wildcard, before any endpoint is considered.
      //
      // Every application on this cluster is published at
      // `<slug>.<cluster>.<zone>` — one label under the cluster's subdomain,
      // always at the same address. One record covers all of them, including
      // the ones that do not exist yet, which is what makes a new application
      // reachable the moment it is deployed rather than a minute later.
      //
      // It is also what keeps the sweep below honest: without this the record
      // is an A record pointing at a cluster master IP that no endpoint claims,
      // which is exactly the definition of an orphan it deletes.
      const wildcard = clusterWildcardRecord(assignment, zone);
      if (wildcard) {
        expected.set(`${wildcard.name}|${wildcard.type}`, wildcard);
      }

      // And, on the sandbox cluster only, the subdomain its tenancies publish
      // under. Same argument as above, and the same consequence if it is left
      // out: the sweep would delete the record hundreds of guest applications
      // resolve through, and nothing would write it back until the next
      // tenancy is provisioned.
      if (this.sandboxSubdomain.ownsCluster(assignment.clusterId)) {
        const shared = sandboxWildcardRecord(
          assignment,
          zone,
          this.sandboxSubdomain.label(),
        );
        if (shared) expected.set(`${shared.name}|${shared.type}`, shared);
      }

      for (const endpoint of assignment.endpoints ?? []) {
        if (endpoint.hostnameMode === HostnameMode.IP) continue;
        const value = endpoint.dnsRecordValue ?? masterIp;
        if (!value) continue;

        const name = resolveRecordName(endpoint.fqdn, zone.zoneName);
        const type = endpoint.dnsRecordType ?? DnsRecordType.A;
        const key = `${name}|${type}`;
        if (expected.has(key)) continue;
        expected.set(key, { name, type, value, ttl: zone.recordTtlSeconds });
      }
    }

    return {
      zoneName: zone.zoneName,
      expected: [...expected.values()],
      clusterMasterIps,
    };
  }

  /**
   * Bring one provider zone into line with the plan: create missing records,
   * fix mismatched value/TTL, and delete orphaned A records whose value is a
   * cluster master IP (label-free, value-predicated — safe on Scaleway too).
   */
  async reconcileTarget(
    target: { dnsProvider: DnsProvider; providerZoneId: string },
    plan: ZoneReconcilePlan,
    opts?: { dryRun?: boolean },
  ): Promise<ReplicaDiffReport> {
    const dryRun = opts?.dryRun ?? false;
    const report: ReplicaDiffReport = {
      provider: target.dnsProvider,
      providerZoneId: target.providerZoneId,
      created: 0,
      updated: 0,
      orphansDeleted: 0,
      mismatches: [],
      errors: [],
    };

    let provider: IDnsProvider;
    let actual: DnsRecordInfo[];
    try {
      provider = this.dnsProviderFactory.getDnsProviderOrFail(
        target.dnsProvider,
      );
      actual = await provider.listRecords(target.providerZoneId);
    } catch (err) {
      report.errors.push(err instanceof Error ? err.message : String(err));
      return report;
    }

    const actualByKey = new Map<string, DnsRecordInfo>();
    for (const r of actual) actualByKey.set(`${r.name}|${r.type}`, r);
    const expectedKeys = new Set<string>();

    for (const exp of plan.expected) {
      expectedKeys.add(`${exp.name}|${exp.type}`);
      await this.applyExpectedRecord(
        provider,
        target,
        exp,
        actualByKey,
        dryRun,
        report,
      );
    }

    await this.sweepOrphans(
      provider,
      target,
      actual,
      plan,
      expectedKeys,
      dryRun,
      report,
    );

    return report;
  }

  private async applyExpectedRecord(
    provider: IDnsProvider,
    target: { dnsProvider: DnsProvider; providerZoneId: string },
    exp: ExpectedDnsRecord,
    actualByKey: Map<string, DnsRecordInfo>,
    dryRun: boolean,
    report: ReplicaDiffReport,
  ): Promise<void> {
    const match = actualByKey.get(`${exp.name}|${exp.type}`);
    try {
      if (!match) {
        if (!dryRun) {
          await provider.createRecord({
            zoneId: target.providerZoneId,
            type: exp.type,
            name: exp.name,
            value: exp.value,
            ttl: exp.ttl,
          });
        }
        report.created++;
        return;
      }
      // A falsy actual TTL means the provider did not report one — don't churn on it.
      const ttlMismatch = !!match.ttl && match.ttl !== exp.ttl;
      if (match.value === exp.value && !ttlMismatch) return;

      report.mismatches.push({
        name: exp.name,
        type: exp.type,
        expected: exp.value,
        actual: match.value,
      });
      if (!dryRun) {
        await provider.updateRecord({
          recordId: match.recordId,
          zoneId: target.providerZoneId,
          type: exp.type,
          name: exp.name,
          value: exp.value,
          ttl: exp.ttl,
        });
      }
      report.updated++;
    } catch (err) {
      report.errors.push(
        `${exp.name}/${exp.type}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async sweepOrphans(
    provider: IDnsProvider,
    target: { dnsProvider: DnsProvider; providerZoneId: string },
    actual: DnsRecordInfo[],
    plan: ZoneReconcilePlan,
    expectedKeys: Set<string>,
    dryRun: boolean,
    report: ReplicaDiffReport,
  ): Promise<void> {
    for (const r of actual) {
      const isOrphan =
        r.type === DnsRecordType.A &&
        plan.clusterMasterIps.has(r.value) &&
        !expectedKeys.has(`${r.name}|${r.type}`);
      if (!isOrphan) continue;

      this.logger.warn(
        `[dns-reconcile] orphan A ${r.name} → ${r.value} in ${target.dnsProvider} zone=${target.providerZoneId}` +
          (dryRun ? ' (dry-run)' : ' — deleting'),
      );
      try {
        if (!dryRun) {
          await provider.deleteRecord(target.providerZoneId, r.recordId);
        }
        report.orphansDeleted++;
      } catch (err) {
        report.errors.push(
          `orphan ${r.name}/A: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Reconcile every target (primary + eligible replicas) of a dual-provider zone. */
  async reconcileZone(zoneId: string): Promise<void> {
    const zone = await this.zoneRepo.findOne({ where: { id: zoneId } });
    if (!zone) return;
    const replicas = (zone.replicas ?? []).filter((r) =>
      FANOUT_ELIGIBLE.includes(r.status),
    );
    if (replicas.length === 0) return;

    const plan = await this.buildExpectation(zone);

    const primary = await this.reconcileTarget(
      { dnsProvider: zone.dnsProvider, providerZoneId: zone.providerZoneId },
      plan,
    );
    this.logReport(zone.zoneName, 'primary', primary);

    for (const replica of replicas) {
      const report = await this.reconcileTarget(
        {
          dnsProvider: replica.dnsProvider,
          providerZoneId: replica.providerZoneId,
        },
        plan,
      );
      const clean = report.errors.length === 0;
      // Guard against a disable landing during the (slow) provider calls above.
      await this.replicaRepo.update(
        { id: replica.id, status: Not(DnsReplicaStatus.DISABLED) },
        {
          status: clean ? DnsReplicaStatus.ACTIVE : DnsReplicaStatus.DEGRADED,
          lastReconciledAt: new Date(),
          errorMessage: clean ? null : report.errors.join('; ').slice(0, 2000),
        },
      );
      this.logReport(zone.zoneName, `replica:${replica.dnsProvider}`, report);
    }
  }

  /** Zone ids that have at least one replica the cron should reconcile. */
  async listReconcilableZoneIds(): Promise<string[]> {
    const rows = await this.replicaRepo.find({
      where: { status: In(FANOUT_ELIGIBLE) },
      select: { dnsZoneId: true },
    });
    return [...new Set(rows.map((r) => r.dnsZoneId))];
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async eligibleReplicas(
    zone: DnsZoneEntity,
  ): Promise<DnsZoneReplicaEntity[]> {
    const replicas =
      zone.replicas ??
      (await this.replicaRepo.find({ where: { dnsZoneId: zone.id } }));
    return replicas.filter((r) => FANOUT_ELIGIBLE.includes(r.status));
  }

  /** Loading replicas must never throw out of the fan-out path (would fail a deploy). */
  private async eligibleReplicasSafe(
    zone: DnsZoneEntity,
  ): Promise<DnsZoneReplicaEntity[]> {
    try {
      return await this.eligibleReplicas(zone);
    } catch (err) {
      this.logger.error(
        `[dns-replica] could not load replicas for zone ${zone.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  private async markReplicaDegraded(
    replica: DnsZoneReplicaEntity,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(
      `[dns-replica] ${replica.dnsProvider} zone=${replica.providerZoneId} write failed: ${message}`,
    );
    // Best-effort bookkeeping; a DB hiccup here must not escape and fail a deploy.
    // Skip DISABLED replicas so a mid-flight disable is not silently reverted.
    try {
      await this.replicaRepo.update(
        { id: replica.id, status: Not(DnsReplicaStatus.DISABLED) },
        {
          status: DnsReplicaStatus.DEGRADED,
          errorMessage: message.slice(0, 2000),
        },
      );
    } catch (dbErr) {
      this.logger.error(
        `[dns-replica] failed to mark ${replica.id} degraded: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      );
    }
  }

  private logReport(
    zoneName: string,
    target: string,
    report: ReplicaDiffReport,
  ): void {
    const level = report.errors.length ? 'warn' : 'log';
    this.logger[level](
      `[dns-reconcile] ${zoneName} ${target}: +${report.created} ~${report.updated} -${report.orphansDeleted}` +
        (report.errors.length ? ` errors=${report.errors.length}` : ''),
    );
  }
}
