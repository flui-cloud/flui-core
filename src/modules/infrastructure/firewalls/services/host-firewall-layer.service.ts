import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import {
  HostLayerBlockedError,
  NftablesFirewallBackend,
} from '../../../providers/core/firewall/nftables-firewall.backend';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';
import {
  ClusterEntity,
  ClusterStatus,
  isControlClusterType,
} from '../../clusters/entities/cluster.entity';
import { ClusterFirewallEntity } from '../entities/cluster-firewall.entity';
import {
  HostFirewallLayerDto,
  HostFirewallLayerState,
} from '../dto/cluster-firewall.dto';
import { FirewallDesiredStateService } from './firewall-desired-state.service';

/** What `cluster_firewalls.metadata.hostLayer` holds. */
export interface HostLayerRecord {
  enabled: boolean;
  lastAppliedFingerprint?: string | null;
  appliedAt?: string | null;
  appliedNodes?: number | null;
  lastError?: string | null;
  blockedReason?: string | null;
  lastAttemptAt?: string | null;
}

export function hostLayerRecordOf(
  firewall: Pick<ClusterFirewallEntity, 'metadata'>,
): HostLayerRecord | undefined {
  const raw = (firewall.metadata as { hostLayer?: HostLayerRecord } | null)
    ?.hostLayer;
  return raw && typeof raw === 'object' ? raw : undefined;
}

/**
 * The nftables ruleset on the nodes of a cloud workload cluster, beneath the
 * provider's firewall.
 *
 * A provider firewall covers only the servers it is attached to: one node that
 * falls outside it exposes everything listening on the host — the shared
 * volume, the overlay between nodes, the node agents. This layer makes each
 * node refuse those on its own, with the same rules the provider is given.
 *
 * It is a second line and is kept apart from the first: its state lives beside
 * the provider firewall's, and nothing here can fail the provider apply.
 */
@Injectable()
export class HostFirewallLayerService {
  private readonly logger = new Logger(HostFirewallLayerService.name);

  constructor(
    private readonly desiredState: FirewallDesiredStateService,
    private readonly capabilities: CapabilitiesProviderFactory,
    private readonly nftables: NftablesFirewallBackend,
  ) {}

  /** Workload clusters whose provider firewall is a cloud resource. */
  isApplicable(cluster: ClusterEntity | null | undefined): boolean {
    if (!cluster || isControlClusterType(cluster.clusterType)) return false;
    try {
      return (
        this.capabilities
          .getCapabilitiesService(cluster.provider as CloudProvider)
          .getStaticCapabilities().firewall.backend === 'managed-api'
      );
    } catch {
      return false;
    }
  }

  /** Turned on for a cluster Flui is creating now; existing ones opt in. */
  async enableAtCreation(firewall: ClusterFirewallEntity): Promise<void> {
    if (!this.isApplicable(firewall.cluster)) return;
    await this.desiredState.rememberHostLayer(firewall.id, { enabled: true });
  }

  async setEnabled(
    clusterId: string,
    enabled: boolean,
  ): Promise<ClusterFirewallEntity> {
    const firewall = await this.desiredState.getFirewallByClusterId(clusterId);
    if (!this.isApplicable(firewall.cluster)) {
      throw new BadRequestException(
        'The host firewall layer is only offered on workload clusters whose ' +
          'provider has its own firewall; on other clusters the host firewall ' +
          'is already the cluster firewall.',
      );
    }
    await this.desiredState.rememberHostLayer(firewall.id, { enabled });
    return this.sync(
      await this.desiredState.getFirewallById(firewall.id),
      firewall.desiredRules ?? [],
    );
  }

  /**
   * Brings the nodes in line with the record: applies the ruleset when it is
   * enabled and has changed, removes it when it was turned off. Never throws;
   * whatever went wrong is written down for the surfaces to show.
   */
  async sync(
    firewall: ClusterFirewallEntity,
    rules: FirewallRuleDto[],
  ): Promise<ClusterFirewallEntity> {
    const cluster = firewall.cluster;
    const record = hostLayerRecordOf(firewall);
    if (!record || !this.isApplicable(cluster)) return firewall;
    if (
      cluster.status === ClusterStatus.DELETED ||
      cluster.status === ClusterStatus.DELETING
    )
      return firewall;

    try {
      if (!record.enabled) {
        if (!record.lastAppliedFingerprint) return firewall;
        await this.nftables.removeHostLayer(cluster.id);
        this.logger.log(`Host firewall removed from cluster ${cluster.id}`);
        return this.record(firewall, {
          lastAppliedFingerprint: null,
          appliedAt: null,
          appliedNodes: null,
          lastError: null,
          blockedReason: null,
        });
      }

      const fingerprint = await this.nftables.hostLayerFingerprint(
        cluster.id,
        rules,
      );
      if (
        fingerprint &&
        fingerprint === record.lastAppliedFingerprint &&
        !record.lastError &&
        !record.blockedReason
      ) {
        return firewall;
      }

      const nodes = await this.nftables.applyHostLayer(cluster.id, rules);
      this.logger.log(
        `Host firewall applied to ${nodes} node(s) of cluster ${cluster.id}`,
      );
      return this.record(firewall, {
        lastAppliedFingerprint: fingerprint ?? null,
        appliedAt: new Date().toISOString(),
        appliedNodes: nodes,
        lastError: null,
        blockedReason: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof HostLayerBlockedError) {
        this.logger.warn(
          `Host firewall of cluster ${cluster.id} not applied: ${message}`,
        );
        return this.record(firewall, {
          blockedReason: message,
          lastError: null,
        });
      }
      this.logger.error(
        `Host firewall of cluster ${cluster.id} failed: ${message}`,
      );
      return this.record(firewall, { lastError: message, blockedReason: null });
    }
  }

  toDto(
    firewall: Pick<ClusterFirewallEntity, 'metadata' | 'cluster'>,
  ): HostFirewallLayerDto {
    const applicable = this.isApplicable(firewall.cluster);
    const record = hostLayerRecordOf(firewall);
    return describeHostLayer(applicable, record);
  }

  private async record(
    firewall: ClusterFirewallEntity,
    patch: Partial<HostLayerRecord>,
  ): Promise<ClusterFirewallEntity> {
    try {
      const saved = await this.desiredState.rememberHostLayer(firewall.id, {
        ...patch,
        lastAttemptAt: new Date().toISOString(),
      });
      return saved;
    } catch (err) {
      this.logger.warn(
        `Could not record the host firewall state of ${firewall.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return firewall;
    }
  }
}

export function describeHostLayer(
  applicable: boolean,
  record: HostLayerRecord | undefined,
): HostFirewallLayerDto {
  const enabled = applicable && !!record?.enabled;
  let state: HostFirewallLayerState;
  if (!applicable) state = HostFirewallLayerState.NOT_APPLICABLE;
  else if (!record?.enabled)
    state = record?.lastAppliedFingerprint
      ? HostFirewallLayerState.REMOVING
      : HostFirewallLayerState.OFF;
  else if (record.lastError) state = HostFirewallLayerState.FAILED;
  else if (record.blockedReason) state = HostFirewallLayerState.BLOCKED;
  else if (record.appliedAt) state = HostFirewallLayerState.APPLIED;
  else state = HostFirewallLayerState.PENDING;

  return {
    applicable,
    enabled,
    state,
    reason: applicable
      ? (record?.lastError ?? record?.blockedReason ?? null)
      : null,
    appliedAt: record?.appliedAt ?? null,
    appliedNodes: record?.appliedNodes ?? null,
    lastAttemptAt: record?.lastAttemptAt ?? null,
  };
}
