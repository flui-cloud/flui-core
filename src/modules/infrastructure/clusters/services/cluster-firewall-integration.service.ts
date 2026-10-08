import { Injectable, Logger } from '@nestjs/common';
import { FirewallDesiredStateService } from '../../firewalls/services/firewall-desired-state.service';
import { FirewallReconciliationService } from '../../firewalls/services/firewall-reconciliation.service';
import { ClusterEntity } from '../entities/cluster.entity';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

/**
 * Service to handle cluster-firewall integration
 * Manages firewall creation and deletion during cluster lifecycle
 */
@Injectable()
export class ClusterFirewallIntegrationService {
  private readonly logger = new Logger(ClusterFirewallIntegrationService.name);

  constructor(
    private readonly firewallDesiredStateService: FirewallDesiredStateService,
    private readonly firewallReconciliationService: FirewallReconciliationService,
  ) {}

  /**
   * Create and reconcile firewall for a cluster
   * IMPORTANT: This MUST be called BEFORE creating any cluster nodes
   */
  async createAndReconcileFirewall(
    cluster: ClusterEntity,
    desiredRules: FirewallRuleDto[],
  ): Promise<string | null> {
    this.logger.log(
      `Creating firewall for cluster ${cluster.id} (provider: ${cluster.provider}) with ${desiredRules.length} rules: ` +
        JSON.stringify(
          desiredRules.map((r) => `${r.direction}:${r.protocol}:${r.port}`),
        ),
    );

    try {
      // A retried creation finds the record its first attempt made.
      const firewall =
        (await this.firewallDesiredStateService
          .getFirewallByClusterId(cluster.id)
          .catch(() => null)) ??
        (await this.firewallDesiredStateService.createFirewall(
          cluster.id,
          desiredRules,
        ));

      this.logger.log(
        `Firewall DB record ${firewall.id} created for cluster ${cluster.id}, triggering provider reconciliation`,
      );

      await this.firewallReconciliationService.enableHostLayerAtCreation(
        firewall.id,
      );

      // Reconcile firewall (create provider firewall)
      const reconciledFirewall =
        await this.firewallReconciliationService.reconcile(firewall.id);

      this.logger.log(
        `Firewall ${firewall.id} reconciled successfully — provider firewall ID: ${reconciledFirewall.providerFirewallId ?? 'NULL (reconciliation may have failed)'}`,
      );

      if (!reconciledFirewall.providerFirewallId) {
        this.logger.error(
          `Reconciliation returned null providerFirewallId for cluster ${cluster.id} — firewall will NOT be attached to nodes`,
        );
      }

      return reconciledFirewall.providerFirewallId;
    } catch (error) {
      this.logger.error(
        `Failed to create and reconcile firewall for cluster ${cluster.id}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /** Puts the host firewall on the nodes that now exist; never throws. */
  async syncHostLayer(clusterId: string): Promise<void> {
    try {
      await this.firewallReconciliationService.syncHostLayerForCluster(
        clusterId,
      );
    } catch (error) {
      this.logger.warn(
        `Host firewall of cluster ${clusterId} not synced: ${error.message}`,
      );
    }
  }

  /**
   * Delete firewall for a cluster
   * Called during cluster deletion
   */
  async deleteClusterFirewall(
    clusterId: string,
    provider: CloudProvider,
  ): Promise<void> {
    this.logger.log(`Deleting firewall for cluster ${clusterId}`);

    try {
      // Get firewall by cluster ID
      const firewall =
        await this.firewallDesiredStateService.getFirewallByClusterId(
          clusterId,
        );

      if (!firewall) {
        this.logger.warn(`No firewall found for cluster ${clusterId}`);
        return;
      }

      // Delete provider firewall
      await this.firewallReconciliationService.deleteProviderFirewall(
        firewall.id,
      );

      // Delete firewall entity
      await this.firewallDesiredStateService.deleteFirewall(firewall.id);

      this.logger.log(`Firewall deleted for cluster ${clusterId}`);
    } catch (error) {
      // Log error but don't fail cluster deletion
      this.logger.error(
        `Failed to delete firewall for cluster ${clusterId}: ${error.message}. Attempting cleanup via labels.`,
        error.stack,
      );

      // Fallback: cleanup orphaned firewalls by cluster label
      try {
        await this.firewallReconciliationService.cleanupOrphanedFirewalls(
          clusterId,
          provider,
        );
        this.logger.log(
          `Cleaned up orphaned firewalls for cluster ${clusterId} via label selector`,
        );
      } catch (cleanupError) {
        this.logger.error(
          `Failed to cleanup orphaned firewalls for cluster ${clusterId}: ${cleanupError.message}`,
          cleanupError.stack,
        );
        // Don't throw - allow cluster deletion to continue
      }
    }
  }
}
