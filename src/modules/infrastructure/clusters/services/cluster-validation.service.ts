import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';
import { CreateClusterDto } from '../dto/create-cluster.dto';
import { NameAvailabilityResponseDto } from '../dto/name-availability.dto';
import { ManagementService } from '../../../management/services/management.service';
import { ProviderFactory } from '../../../providers/core/factories/provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { CacheService } from '../../../common/cache/cache.service';
import { CacheCategory } from '../../../common/cache/enums/cache-category.enum';
import { ServerResponseDto } from '../../servers/dto/server-response.dto';

/**
 * Service responsible for cluster validation logic
 */
@Injectable()
export class ClusterValidationService {
  private readonly logger = new Logger(ClusterValidationService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly managementService: ManagementService,
    private readonly providerFactory: ProviderFactory,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Whether `name` can be used for a new cluster on `provider` right now.
   *
   * Checks Flui's own records first, then the provider's real server
   * inventory for a `${name}-master` — a soft-deleted cluster (status:
   * DELETED) frees the name in our DB by design, but that says nothing about
   * whether its server actually got removed at the provider (e.g. a force
   * delete that swallowed a provider-side failure). Suggesting or accepting
   * such a name sends a brand-new cluster ~8 minutes into provisioning before
   * failing on a collision nobody could have seen coming.
   *
   * The provider check is best-effort: a transient provider/API error is
   * logged and treated as "can't tell", not "unavailable" — this check backs
   * up the deep idempotency guard in ServersService.assertServerIsOurs, it
   * isn't the only line of defense.
   */
  async checkNameAvailability(
    name: string,
    provider: CloudProvider,
  ): Promise<NameAvailabilityResponseDto> {
    const existingCluster = await this.clusterRepository.findOne({
      where: { name, status: Not(ClusterStatus.DELETED) },
    });
    if (existingCluster) {
      return {
        available: false,
        reason: `Cluster with name '${name}' already exists`,
      };
    }

    try {
      const servers = await this.listServersForAvailabilityCheck(provider);
      const masterName = `${name}-master`;
      const hasCollision = servers.some((s) => s.name === masterName);
      if (hasCollision) {
        return {
          available: false,
          reason:
            `A server named "${masterName}" already exists at ${provider} ` +
            '(left over from a past cluster whose deletion did not fully ' +
            'clean up the provider). Choose another name, or remove that ' +
            'server first.',
        };
      }
    } catch (error) {
      this.logger.warn(
        `Could not verify name availability against ${provider}: ${(error as Error).message}`,
      );
    }

    return { available: true };
  }

  /**
   * listServersAsDto() is a real provider API scan (OVH: one call per
   * region) — measured at several seconds. The name-generator on the
   * dashboard calls checkNameAvailability() once per candidate name in a
   * loop, which without this would re-scan the whole account per candidate.
   * A short cache lets one generate click reuse a single fetch; 30s is well
   * inside "obviously stale" territory for how often servers actually
   * appear/disappear, and this cache is one of two guards — the deep
   * idempotency check in ServersService.assertServerIsOurs still runs at
   * actual creation time regardless of what this said.
   */
  private async listServersForAvailabilityCheck(
    provider: CloudProvider,
  ): Promise<ServerResponseDto[]> {
    const cacheKey = `cluster-name-check:servers:${provider}`;
    const cached = await this.cacheService.get<ServerResponseDto[]>(cacheKey);
    if (cached) return cached;

    const servers = await this.providerFactory
      .getProvider(provider)
      .listServersAsDto();
    await this.cacheService.set(cacheKey, servers, {
      category: CacheCategory.REALTIME,
    });
    return servers;
  }

  /**
   * Validate cluster creation request
   */
  async validateCreateClusterRequest(dto: CreateClusterDto): Promise<void> {
    const availability = await this.checkNameAvailability(
      dto.name,
      dto.provider,
    );
    if (!availability.available) {
      throw new ConflictException(availability.reason);
    }

    // Validate node size
    await this.validateNodeSize(dto.provider, dto.region, dto.nodeSize);

    // Node bounds, whenever either is given. They are not behind a flag: the
    // flag never decided whether they were enforced, only whether they were
    // read here.
    if (dto.minNodes != null || dto.maxNodes != null) {
      this.validateAutoscalingConfig(dto);
    }

    // Validate VNet configuration if provided
    if (dto.vnetConfig) {
      this.validateVNetConfig(dto);
    }
  }

  /**
   * Validate node size exists for provider/region
   * Accepts both name (e.g., 'cx22') and ID (e.g., '115')
   */
  private async validateNodeSize(
    provider: string,
    region: string,
    nodeSize: string,
  ): Promise<void> {
    const nodeSizes = await this.managementService.getNodeSizes(
      provider as any,
      region,
    );

    // Accept both name and ID for flexibility
    const hasValidSize = nodeSizes.some(
      (size) => size.name === nodeSize || size.id === nodeSize,
    );

    if (!hasValidSize) {
      throw new BadRequestException(
        `Node size '${nodeSize}' is not available for provider '${provider}' in region '${region}'`,
      );
    }
  }

  /**
   * Validate autoscaling configuration
   */
  private validateAutoscalingConfig(dto: CreateClusterDto): void {
    if (!dto.minNodes || !dto.maxNodes) {
      throw new BadRequestException(
        'Autoscaling enabled but minNodes or maxNodes not provided',
      );
    }

    if (dto.minNodes > dto.maxNodes) {
      throw new BadRequestException('minNodes cannot be greater than maxNodes');
    }

    if (dto.minNodes < 1) {
      throw new BadRequestException('minNodes must be at least 1');
    }

    if (dto.maxNodes > 20) {
      throw new BadRequestException('maxNodes cannot exceed 20');
    }
  }

  /**
   * Validate VNet configuration
   */
  private validateVNetConfig(dto: CreateClusterDto): void {
    if (!dto.vnetConfig.vnetId) {
      throw new BadRequestException('vnetConfig.vnetId is required');
    }

    // Additional VNet validations can be added here
    // For example, verify VNet exists and is in the same provider/region
  }
}
