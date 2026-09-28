import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FirewallEntity } from '../entities/firewall.entity';
import { ClusterFirewallEntity } from '../entities/cluster-firewall.entity';
import { ProviderFirewallDto } from '../../../providers/dto/firewall.dto';
import {
  ClusterEntity,
  ClusterType,
  isControlClusterType,
} from '../../clusters/entities/cluster.entity';
import { FirewallProviderFactory } from '../../../providers/services/firewall-provider.factory';
import { LabelService } from '../../shared/services/label.service';
import {
  FirewallRule,
  CreateFirewallConfig,
  FirewallDetails,
  IFirewallProvider,
} from '../../../providers/interfaces/firewall-provider.interface';
import {
  getFirewallRulesForClusterType,
  validateFirewallRules,
} from '../templates/firewall-rules.template';
import { FirewallConfigDto } from '../dto/firewall-config.dto';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

@Injectable()
export class FirewallsService {
  private readonly logger = new Logger(FirewallsService.name);

  constructor(
    @InjectRepository(FirewallEntity)
    private readonly firewallRepository: Repository<FirewallEntity>,
    @InjectRepository(ClusterFirewallEntity)
    private readonly clusterFirewallRepository: Repository<ClusterFirewallEntity>,
    private readonly firewallProviderFactory: FirewallProviderFactory,
    private readonly labelService: LabelService,
  ) {}

  /**
   * Create a firewall for a cluster
   * @param cluster Cluster entity
   * @param config Firewall configuration
   * @returns Created firewall entity
   */
  async createFirewallForCluster(
    cluster: ClusterEntity,
    config?: FirewallConfigDto,
  ): Promise<FirewallEntity> {
    this.logger.log(
      `Creating firewall for cluster ${cluster.id} (${cluster.name})`,
    );

    // Check if firewall is disabled
    if (config?.enabled === false) {
      this.logger.log(`Firewall creation disabled for cluster ${cluster.id}`);
      return null;
    }

    // Check if provider supports firewall
    const provider = cluster.provider as CloudProvider;
    if (!this.firewallProviderFactory.supportsFirewall(provider)) {
      const message = `Firewall not supported for provider: ${provider}`;

      if (config?.required) {
        throw new BadRequestException(
          `${message}. Set firewallConfig.required=false to proceed without firewall.`,
        );
      }

      this.logger.warn(`${message}. Skipping firewall creation.`);
      return null;
    }

    // Get provider-specific firewall service
    const firewallProvider =
      this.firewallProviderFactory.getFirewallProviderOrFail(provider);

    // Determine firewall rules
    const rules = this.determineFirewallRules(cluster, config);

    // Validate rules
    const validation = validateFirewallRules(rules);
    if (!validation.valid) {
      throw new BadRequestException(
        `Invalid firewall rules: ${validation.errors.join(', ')}`,
      );
    }

    // Determine source CIDRs
    const sourceCidrs = config?.sourceCidrs || [];
    if (sourceCidrs.length === 0) {
      this.logger.warn(
        'No source CIDRs provided. Firewall will be created but may need manual configuration.',
      );
    }

    // Generate labels
    const labels = this.labelService.toRecord([
      { key: 'managed-by', value: 'flui-cloud' },
      { key: 'flui-resource-type', value: 'firewall' },
      { key: 'flui-cluster-id', value: cluster.id },
      { key: 'flui-cluster-type', value: cluster.clusterType },
    ]);

    // Create firewall name with cluster ID to ensure uniqueness
    const firewallName = `flui-${cluster.clusterType}-${cluster.name}-${cluster.id}`;

    // Create firewall config
    const createConfig: CreateFirewallConfig = {
      name: firewallName,
      labels: this.labelService.fromRecord(labels),
      rules,
      applyToLabelSelector: `flui-cluster-id=${cluster.id}`, // Auto-apply to all cluster nodes
    };

    try {
      // Create firewall via provider
      const result = await firewallProvider.createFirewall(createConfig);

      this.logger.log(
        `Firewall created successfully: ${result.firewallId} for cluster ${cluster.id}`,
      );

      // Save to database
      const firewall = this.firewallRepository.create({
        id: result.firewallId,
        name: firewallName,
        provider: cluster.provider,
        clusterId: cluster.id,
        rules,
        sourceCidrs,
        labels,
        metadata: {
          labelSelector: `flui-cluster-id=${cluster.id}`,
          clusterName: cluster.name,
          clusterType: cluster.clusterType,
        },
      });

      return await this.firewallRepository.save(firewall);
    } catch (error) {
      this.logger.error(
        `Failed to create firewall for cluster ${cluster.id}: ${error.message}`,
        error.stack,
      );

      if (config?.required) {
        throw new BadRequestException(
          `Failed to create required firewall: ${error.message}`,
        );
      }

      this.logger.warn(
        `Firewall creation failed but is not required. Continuing without firewall.`,
      );
      return null;
    }
  }

  /**
   * Determine firewall rules based on cluster type and custom config
   */
  private determineFirewallRules(
    cluster: ClusterEntity,
    config?: FirewallConfigDto,
  ): FirewallRule[] {
    // Use custom rules if provided
    if (config?.customRules && config.customRules.length > 0) {
      this.logger.log(`Using custom firewall rules for cluster ${cluster.id}`);
      return config.customRules;
    }

    // Use default rules based on cluster type
    const sourceCidrs = config?.sourceCidrs || ['0.0.0.0/0', '::/0']; // Allow all if no CIDRs
    const clusterType = isControlClusterType(cluster.clusterType)
      ? 'control'
      : 'workload';

    this.logger.log(
      `Using default ${clusterType} firewall rules for cluster ${cluster.id}`,
    );

    return getFirewallRulesForClusterType(clusterType, sourceCidrs);
  }

  /**
   * Get firewall for a cluster
   */
  async getFirewallByClusterId(
    clusterId: string,
  ): Promise<FirewallEntity | null> {
    return await this.firewallRepository.findOne({
      where: { clusterId, deletedAt: null },
    });
  }

  /**
   * The cluster's firewall as the provider has it. A cluster created since
   * firewalls moved to `cluster_firewalls` has no row in the old table, so
   * that one is only the fallback; the servers counted are the ones the
   * provider says the firewall is attached to, never an assumption.
   */
  async describeClusterFirewall(
    clusterId: string,
    provider: CloudProvider,
  ): Promise<ProviderFirewallDto> {
    const current = await this.clusterFirewallRepository.findOne({
      where: { clusterId },
    });
    if (current?.providerFirewallId) {
      const backend =
        this.firewallProviderFactory.getFirewallProvider(provider);
      let live: FirewallDetails | null = null;
      if (backend) {
        try {
          live = await backend.getFirewall(current.providerFirewallId);
        } catch (error) {
          throw new BadGatewayException(
            `The ${provider} firewall of this cluster could not be read: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!live) {
        throw new NotFoundException(
          `The firewall ${current.providerFirewallId} of cluster ${clusterId} no longer exists at ${provider}`,
        );
      }
      return {
        id: live.id,
        name: live.name,
        provider,
        rules: live.rules,
        appliedToServerCount: live.appliedTo.length,
        labels: live.labels,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      };
    }

    const legacy = await this.getFirewallByClusterId(clusterId);
    if (!legacy) {
      throw new NotFoundException(`No firewall found for cluster ${clusterId}`);
    }
    return {
      id: legacy.id,
      name: legacy.name,
      provider: legacy.provider,
      rules: legacy.rules,
      appliedToServerCount: legacy.appliedToServerIds?.length || 0,
      labels: legacy.labels,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    };
  }

  /**
   * Get firewall by ID
   */
  async getFirewallById(firewallId: string): Promise<FirewallEntity> {
    const firewall = await this.firewallRepository.findOne({
      where: { id: firewallId, deletedAt: null },
    });

    if (!firewall) {
      throw new NotFoundException(`Firewall with ID ${firewallId} not found`);
    }

    return firewall;
  }

  /**
   * List all firewalls with optional filtering
   */
  async listFirewalls(filters?: {
    provider?: string;
    clusterId?: string;
  }): Promise<FirewallEntity[]> {
    const queryBuilder = this.firewallRepository
      .createQueryBuilder('firewall')
      .where('firewall.deletedAt IS NULL');

    if (filters?.provider) {
      queryBuilder.andWhere('firewall.provider = :provider', {
        provider: filters.provider,
      });
    }

    if (filters?.clusterId) {
      queryBuilder.andWhere('firewall.clusterId = :clusterId', {
        clusterId: filters.clusterId,
      });
    }

    return await queryBuilder.getMany();
  }

  /**
   * Update firewall rules
   */
  async updateFirewallRules(
    firewallId: string,
    newRules: FirewallRule[],
  ): Promise<FirewallEntity> {
    const firewall = await this.getFirewallById(firewallId);

    // Validate new rules
    const validation = validateFirewallRules(newRules);
    if (!validation.valid) {
      throw new BadRequestException(
        `Invalid firewall rules: ${validation.errors.join(', ')}`,
      );
    }

    // Check if cluster is running - prevent SSH lockout
    if (firewall.cluster) {
      const currentHasSsh = firewall.rules.some(
        (r) => r.direction === 'in' && r.port === '22',
      );
      const newHasSsh = newRules.some(
        (r) => r.direction === 'in' && r.port === '22',
      );

      if (currentHasSsh && !newHasSsh && firewall.cluster.status === 'ready') {
        throw new BadRequestException(
          'Cannot remove SSH access from running cluster firewall. This would lock you out.',
        );
      }
    }

    // Update via provider
    const provider = this.firewallProviderFactory.getFirewallProviderOrFail(
      firewall.provider as CloudProvider,
    );
    await provider.updateFirewallRules(firewallId, newRules);

    // Update in database
    firewall.rules = newRules;
    return await this.firewallRepository.save(firewall);
  }

  /**
   * Delete firewall
   */
  async deleteFirewall(
    firewallId: string,
    force: boolean = false,
  ): Promise<void> {
    const firewall = await this.getFirewallById(firewallId);

    // Validate Flui ownership
    if (!force) {
      const isFluiManaged = firewall.labels?.['managed-by'] === 'flui-cloud';
      if (!isFluiManaged) {
        throw new ForbiddenException(
          'Cannot delete firewall not managed by Flui. Use force=true to override.',
        );
      }
    }

    // Delete from provider
    const provider = this.firewallProviderFactory.getFirewallProviderOrFail(
      firewall.provider as CloudProvider,
    );

    try {
      await provider.deleteFirewall(firewallId);
    } catch (error) {
      this.logger.error(
        `Failed to delete firewall ${firewallId} from provider: ${error.message}`,
      );

      if (!force) {
        throw new BadRequestException(
          `Failed to delete firewall from provider: ${error.message}. Use force=true to delete from database anyway.`,
        );
      }
    }

    // Soft delete from database
    firewall.deletedAt = new Date();
    await this.firewallRepository.save(firewall);

    this.logger.log(`Firewall ${firewallId} deleted successfully`);
  }

  /**
   * Apply firewall to additional servers
   */
  async applyToServers(firewallId: string, serverIds: string[]): Promise<void> {
    const firewall = await this.getFirewallById(firewallId);

    const provider = this.firewallProviderFactory.getFirewallProviderOrFail(
      firewall.provider as CloudProvider,
    );

    await provider.applyToServers(firewallId, serverIds);

    // Update applied server IDs in database
    const uniqueServerIds = [
      ...new Set([...firewall.appliedToServerIds, ...serverIds]),
    ];
    firewall.appliedToServerIds = uniqueServerIds;
    await this.firewallRepository.save(firewall);

    this.logger.log(
      `Firewall ${firewallId} applied to ${serverIds.length} additional servers`,
    );
  }

  /**
   * Remove firewall from servers
   */
  async removeFromServers(
    firewallId: string,
    serverIds: string[],
  ): Promise<void> {
    const firewall = await this.getFirewallById(firewallId);

    const provider = this.firewallProviderFactory.getFirewallProviderOrFail(
      firewall.provider as CloudProvider,
    );

    await provider.removeFromServers(firewallId, serverIds);

    // Update applied server IDs in database
    firewall.appliedToServerIds = firewall.appliedToServerIds.filter(
      (id) => !serverIds.includes(id),
    );
    await this.firewallRepository.save(firewall);

    this.logger.log(
      `Firewall ${firewallId} removed from ${serverIds.length} servers`,
    );
  }

  /**
   * Get firewall provider interface for direct operations
   */
  getFirewallProvider(provider: CloudProvider): IFirewallProvider | null {
    return this.firewallProviderFactory.getFirewallProvider(provider);
  }
}
