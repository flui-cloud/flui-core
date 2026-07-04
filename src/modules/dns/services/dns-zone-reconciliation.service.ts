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

export interface ExpectedDnsRecord {
  name: string;
  type: DnsRecordType;
  value: string;
  ttl: number;
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
