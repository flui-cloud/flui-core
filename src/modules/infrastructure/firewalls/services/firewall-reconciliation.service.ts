import {
  Injectable,
  Logger,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FirewallDesiredStateService } from './firewall-desired-state.service';
import { FirewallProviderFactory } from '../../../providers/services/firewall-provider.factory';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import { LabelService } from '../../../common/services/label.service';
import {
  ClusterFirewallEntity,
  ReconciliationStatus,
} from '../entities/cluster-firewall.entity';
import {
  ClusterEntity,
  isControlClusterType,
} from '../../clusters/entities/cluster.entity';
import { getFirewallRulesForClusterType } from '../templates/firewall-rules.template';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

@Injectable()
export class FirewallReconciliationService {
  private readonly logger = new Logger(FirewallReconciliationService.name);

  constructor(
    private readonly desiredStateService: FirewallDesiredStateService,
    private readonly firewallProviderFactory: FirewallProviderFactory,
    private readonly capabilitiesFactory: CapabilitiesProviderFactory,
    private readonly labelService: LabelService,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
  ) {}

  async ensureClusterFirewall(
    clusterId: string,
  ): Promise<ClusterFirewallEntity> {
    const existing = await this.findFirewallByClusterId(clusterId);
    if (existing) {
      this.logger.log(
        `Firewall already exists for cluster ${clusterId}; reconciling`,
      );
      return this.reconcile(existing.id);
    }

    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new BadRequestException(`Cluster ${clusterId} not found`);
    }

    const clusterType = isControlClusterType(cluster.clusterType)
      ? 'control'
      : 'workload';
    const baseRules = getFirewallRulesForClusterType(clusterType, [
      '0.0.0.0/0',
      '::/0',
    ]) as FirewallRuleDto[];
    const rules = this.normalizeRulesForCapability(cluster.provider, baseRules);

    this.logger.log(
      `Seeding ${clusterType} firewall for cluster ${clusterId} (provider ${cluster.provider})`,
    );
    const firewall = await this.desiredStateService.createFirewall(
      clusterId,
      rules,
    );
    return this.reconcile(firewall.id);
  }

  async reconcileClusterFirewallIfExists(
    clusterId: string,
  ): Promise<ClusterFirewallEntity | null> {
    const existing = await this.findFirewallByClusterId(clusterId);
    if (!existing) return null;
    return this.reconcile(existing.id);
  }

  private async findFirewallByClusterId(
    clusterId: string,
  ): Promise<ClusterFirewallEntity | null> {
    try {
      return await this.desiredStateService.getFirewallByClusterId(clusterId);
    } catch {
      return null;
    }
  }

  normalizeRulesForCapability(
    provider: string,
    rules: FirewallRuleDto[],
  ): FirewallRuleDto[] {
    let supportsSshAllowlist = true;
    try {
      if (
        this.capabilitiesFactory.isProviderSupported(provider as CloudProvider)
      ) {
        supportsSshAllowlist = this.capabilitiesFactory
          .getCapabilitiesService(provider as CloudProvider)
          .getStaticCapabilities().firewall.supportsSshAllowlist;
      }
    } catch {
      supportsSshAllowlist = true;
    }

    if (supportsSshAllowlist) return rules;

    return rules.map((rule) =>
      rule.direction === 'in' && rule.protocol === 'tcp' && rule.port === '22'
        ? { ...rule, sourceIps: ['0.0.0.0/0', '::/0'] }
        : rule,
    );
  }

  private static readonly REQUIRED_INGRESS_TCP = ['443', '80'];

  static assertRequiredIngress(rules: FirewallRuleDto[]): void {
    const inboundTcpPorts = new Set(
      rules
        .filter((r) => r.direction === 'in' && r.protocol === 'tcp' && r.port)
        .map((r) => r.port as string),
    );
    const missing = FirewallReconciliationService.REQUIRED_INGRESS_TCP.filter(
      (port) => !inboundTcpPorts.has(port),
    );
    if (missing.length > 0) {
      throw new UnprocessableEntityException(
        `Firewall must keep inbound TCP ${missing.join(' and ')} open — ` +
          `443 serves the dashboard, API and apps over HTTPS (Traefik) and 80 serves ` +
          `ACME HTTP-01 cert renewal + the HTTP→HTTPS redirect. Removing them would lock ` +
          `you out of the cluster. You can restrict the source IPs, but the ports must stay ` +
          `present. (SSH :22 stays open automatically on a host firewall; egress is not restricted.)`,
      );
    }
  }

  /**
   * Update desired rules and apply them atomically.
   * If provider application fails, no changes are saved to the database.
   */
  async updateAndApplyRules(
    firewallId: string,
    newRules: FirewallRuleDto[],
  ): Promise<ClusterFirewallEntity> {
    this.logger.log(
      `Updating and applying rules for firewall ${firewallId} (atomic operation)`,
    );

    // Get current firewall state
    const firewall = await this.desiredStateService.getFirewallById(firewallId);
    const cluster = firewall.cluster;

    if (!cluster) {
      throw new BadRequestException('Cluster not found for firewall');
    }

    const normalizedRules = this.normalizeRulesForCapability(
      cluster.provider,
      newRules,
    );
    FirewallReconciliationService.assertRequiredIngress(normalizedRules);
    const canonicalRules =
      this.desiredStateService.canonicalizeRules(normalizedRules);
    const newDesiredHash =
      this.desiredStateService.calculateHash(canonicalRules);

    // Check if rules actually changed
    if (newDesiredHash === firewall.desiredHash) {
      this.logger.log(
        `No changes detected for firewall ${firewallId}, skipping update`,
      );
      return firewall;
    }

    // Mark as reconciling temporarily (without persisting to DB yet)
    await this.desiredStateService.updateReconciliationStatus(
      firewallId,
      ReconciliationStatus.RECONCILING,
    );

    try {
      const provider = this.firewallProviderFactory.getFirewallProvider(
        cluster.provider as CloudProvider,
      );

      // Apply to provider FIRST (fail fast if provider has issues)
      if (firewall.providerFirewallId) {
        this.logger.log(
          `Applying rules to existing provider firewall ${firewall.providerFirewallId}`,
        );

        await provider.updateFirewallRules(
          firewall.providerFirewallId,
          canonicalRules,
        );
      } else {
        // Create new provider firewall
        this.logger.log(
          `Creating new provider firewall for cluster ${cluster.id}`,
        );

        const firewallName = this.generateFirewallName(cluster.name);
        const labelsRecord = this.generateFirewallLabels(
          firewall.id,
          cluster.id,
        );
        const labels = Object.entries(labelsRecord).map(([key, value]) => ({
          key,
          value,
        }));
        const labelSelector = `flui-cluster-id=${cluster.id}`;

        const providerFirewall = await provider.createFirewall({
          name: firewallName,
          rules: canonicalRules,
          labels,
          applyToLabelSelector: labelSelector,
        });

        firewall.providerFirewallId = providerFirewall.firewallId;
        this.logger.log(
          `Created provider firewall ${providerFirewall.firewallId}`,
        );
      }

      // SUCCESS: Now save to database
      this.logger.log(
        `Provider update successful, saving to database for firewall ${firewallId}`,
      );

      const savedFirewall =
        await this.desiredStateService.updateDesiredAndAppliedState(
          firewall,
          canonicalRules,
          firewall.providerFirewallId,
        );

      this.logger.log(
        `Firewall ${firewallId} updated and applied successfully`,
      );
      return savedFirewall;
    } catch (error) {
      this.logger.error(
        `Failed to apply rules to provider for firewall ${firewallId}: ${error.message}`,
        error.stack,
      );

      // Restore previous status (don't save the new rules)
      await this.desiredStateService.updateReconciliationStatus(
        firewallId,
        firewall.reconciliationStatus, // Restore original status
        `Failed to apply rules: ${error.message}`,
      );

      // Re-throw to return HTTP 500 to client
      throw error;
    }
  }

  /**
   * Reconcile firewall: create or update provider firewall to match desired state
   */
  async reconcile(firewallId: string): Promise<ClusterFirewallEntity> {
    this.logger.log(`Starting reconciliation for firewall ${firewallId}`);

    const firewall = await this.desiredStateService.getFirewallById(firewallId);

    // Mark as reconciling
    await this.desiredStateService.updateReconciliationStatus(
      firewallId,
      ReconciliationStatus.RECONCILING,
    );

    try {
      const cluster = firewall.cluster;
      if (!cluster) {
        throw new BadRequestException('Cluster not found for firewall');
      }

      const provider = this.firewallProviderFactory.getFirewallProvider(
        cluster.provider as CloudProvider,
      );

      const canonicalRules = this.desiredStateService.canonicalizeRules(
        firewall.desiredRules,
      );

      // Generate firewall name
      const firewallName = this.generateFirewallName(cluster.name);

      // Generate labels for firewall
      const labelsRecord = this.generateFirewallLabels(firewall.id, cluster.id);
      const labels = Object.entries(labelsRecord).map(([key, value]) => ({
        key,
        value,
      }));

      if (firewall.providerFirewallId) {
        // Update existing provider firewall
        this.logger.log(
          `Updating provider firewall ${firewall.providerFirewallId}`,
        );

        await provider.updateFirewallRules(
          firewall.providerFirewallId,
          canonicalRules,
        );

        // Mark reconciliation complete
        return await this.desiredStateService.markReconciliationComplete(
          firewallId,
          canonicalRules,
          firewall.providerFirewallId,
        );
      } else {
        // Create new provider firewall
        this.logger.log(
          `Creating new provider firewall for cluster ${cluster.id}`,
        );

        const labelSelector = `flui-cluster-id=${cluster.id}`;

        const providerFirewall = await provider.createFirewall({
          name: firewallName,
          rules: canonicalRules,
          labels,
          applyToLabelSelector: labelSelector,
        });

        this.logger.log(
          `Created provider firewall ${providerFirewall.firewallId} for cluster ${cluster.id}`,
        );

        // Mark reconciliation complete
        return await this.desiredStateService.markReconciliationComplete(
          firewallId,
          canonicalRules,
          providerFirewall.firewallId,
        );
      }
    } catch (error) {
      this.logger.error(
        `Reconciliation failed for firewall ${firewallId}: ${error.message}`,
        error.stack,
      );

      await this.desiredStateService.updateReconciliationStatus(
        firewallId,
        ReconciliationStatus.ERROR,
        error.message,
      );

      throw error;
    }
  }

  /**
   * Fetch actual state from provider and compare with desired state
   */
  async fetchActualState(firewallId: string): Promise<FirewallRuleDto[]> {
    const firewall = await this.desiredStateService.getFirewallById(firewallId);

    if (!firewall.providerFirewallId) {
      return [];
    }

    const cluster = firewall.cluster;
    const provider = this.firewallProviderFactory.getFirewallProvider(
      cluster.provider as CloudProvider,
    );

    const providerFirewall = await provider.getFirewall(
      firewall.providerFirewallId,
    );

    return providerFirewall.rules || [];
  }

  /**
   * Delete provider firewall
   */
  async deleteProviderFirewall(firewallId: string): Promise<void> {
    const firewall = await this.desiredStateService.getFirewallById(firewallId);

    if (!firewall.providerFirewallId) {
      this.logger.warn(
        `No provider firewall ID for firewall ${firewallId}, skipping deletion`,
      );
      return;
    }

    const cluster = firewall.cluster;
    const provider = this.firewallProviderFactory.getFirewallProvider(
      cluster.provider as CloudProvider,
    );

    this.logger.log(
      `Deleting provider firewall ${firewall.providerFirewallId}`,
    );

    await provider.deleteFirewall(firewall.providerFirewallId);

    this.logger.log(`Deleted provider firewall ${firewall.providerFirewallId}`);
  }

  /**
   * Cleanup orphaned provider firewalls by cluster ID
   * Used as fallback during cluster deletion
   */
  async cleanupOrphanedFirewalls(
    clusterId: string,
    provider: CloudProvider,
  ): Promise<void> {
    this.logger.log(`Cleaning up orphaned firewalls for cluster ${clusterId}`);

    const firewallProvider =
      this.firewallProviderFactory.getFirewallProvider(provider);

    const firewalls = await firewallProvider.listFirewalls({
      labelSelector: `flui-cluster-id=${clusterId}`,
    });

    for (const firewall of firewalls) {
      // Verify it's a Flui-managed firewall
      if (
        firewall.labels?.['managed-by'] === 'flui-cloud' &&
        firewall.labels['flui-cluster-id'] === clusterId
      ) {
        this.logger.log(`Deleting orphaned firewall ${firewall.id}`);
        await firewallProvider.deleteFirewall(firewall.id);
      }
    }
  }

  /**
   * Generate firewall name with short ID
   */
  private generateFirewallName(clusterName: string): string {
    const shortId = Math.random().toString(36).substring(2, 8);
    return `flui-${clusterName}-${shortId}`;
  }

  /**
   * Generate standard labels for firewall
   */
  private generateFirewallLabels(
    firewallId: string,
    clusterId: string,
  ): Record<string, string> {
    return {
      'managed-by': 'flui-cloud',
      'flui-resource-type': 'cluster-firewall',
      'flui-cluster-id': clusterId,
      'flui-firewall-id': firewallId,
    };
  }
}
