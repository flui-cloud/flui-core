import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { DnsProviderFactory } from '../../providers/core/factories/dns-provider.factory';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';
import { ClusterDnsZoneEntity } from '../entities/cluster-dns-zone.entity';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { resolveRecordName } from '../utils/resolve-record-name.util';
import {
  RecordedIngressAddresses,
  clusterIngressValues,
  ingressAddresses,
  ingressRecordTtl,
  sameValues,
} from '../utils/ingress-addresses.core';
import {
  DnsZoneReconciliationService,
  clusterWildcardRecord,
  wildcardLabels,
} from './dns-zone-reconciliation.service';
import { ENDPOINT_ID_LABEL } from '../constants/endpoint-labels';

export type IngressReconcileOutcome =
  | { state: 'unchanged'; addresses: string[] }
  | { state: 'moved'; from: string[]; addresses: string[]; records: number }
  | { state: 'unmeasured'; reason: string };

/**
 * Keeps a cluster's public names pointing at every node that can take traffic.
 *
 * The only place that asks Kubernetes which nodes are ready and run the
 * ingress proxy. What it measures is recorded on the cluster, and every other
 * writer of the cluster's A records reads that record, so they all agree.
 *
 * A measurement that finds no node at all is not published: a cluster that
 * does not answer is not a cluster with nowhere to send traffic, and an empty
 * answer would take every application offline at once.
 */
@Injectable()
export class ClusterIngressReconciler {
  private readonly logger = new Logger(ClusterIngressReconciler.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ClusterDnsZoneEntity)
    private readonly assignments: Repository<ClusterDnsZoneEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly dnsProviders: DnsProviderFactory,
    private readonly zoneReconciliation: DnsZoneReconciliationService,
  ) {}

  async reconcile(clusterId: string): Promise<IngressReconcileOutcome> {
    const cluster = await this.clusters.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster?.kubeconfigEncrypted) {
      return { state: 'unmeasured', reason: 'no kubeconfig' };
    }

    let measured: string[];
    try {
      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
      measured = ingressAddresses(
        await this.kubernetes.listIngressNodeStates(kubeconfig),
        cluster.nodes ?? [],
      );
    } catch (err) {
      return {
        state: 'unmeasured',
        reason: describe(err),
      };
    }
    if (measured.length === 0) {
      return {
        state: 'unmeasured',
        reason: 'no ready node runs the ingress proxy with a public address',
      };
    }

    const previous = clusterIngressValues(cluster);
    const alreadyRecorded = !!(
      cluster.metadata as { ingressAddresses?: RecordedIngressAddresses }
    )?.ingressAddresses;
    if (alreadyRecorded && sameValues(previous, measured)) {
      return { state: 'unchanged', addresses: measured };
    }

    await this.record(cluster, measured);
    cluster.metadata = this.withAddresses(cluster, measured);
    const records = await this.repoint(cluster, previous, measured);
    if (!sameValues(previous, measured)) {
      this.logger.log(
        `[ingress] ${cluster.name}: ${previous.join(', ') || 'none'} → ${measured.join(', ')} (${records} record(s) moved)`,
      );
    }
    return { state: 'moved', from: previous, addresses: measured, records };
  }

  private withAddresses(
    cluster: ClusterEntity,
    addresses: string[],
  ): ClusterEntity['metadata'] {
    const recorded: RecordedIngressAddresses = {
      addresses,
      measuredAt: new Date().toISOString(),
    };
    return { ...cluster.metadata, ingressAddresses: recorded };
  }

  /** Merged onto the freshest metadata so a concurrent write is not undone. */
  private async record(cluster: ClusterEntity, addresses: string[]) {
    const fresh = await this.clusters.findOne({ where: { id: cluster.id } });
    await this.clusters.update(cluster.id, {
      metadata: this.withAddresses(fresh ?? cluster, addresses),
    });
  }

  /**
   * Rewrites the names this cluster owns: each per-application record, and
   * the cluster wildcard when it still names only this cluster's addresses —
   * one pointing anywhere else is somebody's decision and is left alone.
   */
  private async repoint(
    cluster: ClusterEntity,
    previous: string[],
    addresses: string[],
  ): Promise<number> {
    const assignments = await this.assignments.find({
      where: { clusterId: cluster.id },
      relations: ['dnsZone', 'endpoints'],
    });
    const own = new Set([
      ...previous,
      ...addresses,
      ...(cluster.masterIpAddress ? [cluster.masterIpAddress] : []),
    ]);
    let moved = 0;
    for (const assignment of assignments) {
      moved += await this.repointZone(cluster, assignment, own, addresses);
    }
    return moved;
  }

  private async repointZone(
    cluster: ClusterEntity,
    assignment: ClusterDnsZoneEntity,
    own: Set<string>,
    addresses: string[],
  ): Promise<number> {
    const zone = assignment.dnsZone;
    if (!zone) return 0;
    const provider = this.dnsProviders.getDnsProviderOrFail(zone.dnsProvider);
    let actual: ZoneRecord[];
    try {
      actual = await provider.listRecords(zone.providerZoneId);
    } catch (err) {
      this.logger.warn(
        `[ingress] could not read ${zone.zoneName}: ${describe(err)}`,
      );
      return 0;
    }
    const ttl = ingressRecordTtl(zone.recordTtlSeconds, addresses.length);
    let moved = 0;
    for (const target of this.namesToMove(cluster, assignment, actual, own)) {
      if (sameValues(valuesAt(actual, target.name, target.type), addresses)) {
        continue;
      }
      try {
        await provider.setRecordValues({
          zoneId: zone.providerZoneId,
          type: target.type,
          name: target.name,
          values: addresses,
          ttl,
          labels: target.labels,
        });
        await this.zoneReconciliation.fanOutRecordToReplicas(zone, {
          name: target.name,
          type: target.type,
          value: addresses[0],
          values: addresses,
          ttl,
        });
        moved++;
      } catch (err) {
        this.logger.warn(
          `[ingress] could not move ${target.name}.${zone.zoneName}: ${describe(err)}`,
        );
      }
    }
    return moved;
  }

  /** The cluster wildcard, if it is ours, and every per-application record already published. */
  private namesToMove(
    cluster: ClusterEntity,
    assignment: ClusterDnsZoneEntity,
    actual: ZoneRecord[],
    own: Set<string>,
  ): NameToMove[] {
    const zone = assignment.dnsZone;
    const names: NameToMove[] = [];
    const wildcard = clusterWildcardRecord({ ...assignment, cluster }, zone);
    if (wildcard) {
      const current = valuesAt(actual, wildcard.name, wildcard.type);
      if (current.length > 0 && current.every((v) => own.has(v))) {
        names.push({
          name: wildcard.name,
          type: wildcard.type,
          labels: wildcardLabels(cluster.id),
        });
      }
    }
    for (const endpoint of assignment.endpoints ?? []) {
      if (endpoint.hostnameMode === HostnameMode.IP || !endpoint.dnsRecordId) {
        continue;
      }
      const name = resolveRecordName(endpoint.fqdn, zone.zoneName);
      const type = endpoint.dnsRecordType ?? DnsRecordType.A;
      if (valuesAt(actual, name, type).length === 0) continue;
      names.push({
        name,
        type,
        labels: {
          'managed-by': 'flui-cloud',
          'flui-resource-type': 'dns-record',
          'flui-cluster-id': cluster.id,
          [ENDPOINT_ID_LABEL]: endpoint.id,
        },
      });
    }
    return names;
  }
}

interface ZoneRecord {
  name: string;
  type: string;
  value: string;
}

interface NameToMove {
  name: string;
  type: DnsRecordType;
  labels: Record<string, string>;
}

function valuesAt(
  records: ZoneRecord[],
  name: string,
  type: DnsRecordType,
): string[] {
  return records
    .filter((r) => r.name === name && r.type === type)
    .map((r) => r.value);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : JSON.stringify(err);
}
