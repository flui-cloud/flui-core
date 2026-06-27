import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VNetEntity, VNetStatus } from '../entities/vnet.entity';
import { VNetSubnetEntity, SubnetType } from '../entities/vnet-subnet.entity';
import { VNetRouteEntity } from '../entities/vnet-route.entity';
import { ProviderFactory } from 'src/modules/providers/services/provider.factory';
import { CapabilitiesProviderFactory } from 'src/modules/providers/core/factories/capabilities-provider.factory';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { CreateVNetDto } from '../dto/create-vnet.dto';
import { VNetResponseDto, VNetListResponseDto } from '../dto/vnet-response.dto';
import { AddSubnetDto } from '../dto/add-subnet.dto';
import { DeleteSubnetDto } from '../dto/delete-subnet.dto';
import { SubnetCalculator } from '../utils/subnet-calculator';
import { AddSubnetResult } from 'src/modules/providers/interfaces/network-provider.interface';
import * as ipaddr from 'ipaddr.js';

@Injectable()
export class VNetsService {
  private readonly logger = new Logger(VNetsService.name);

  constructor(
    @InjectRepository(VNetEntity)
    private readonly vnetRepository: Repository<VNetEntity>,
    @InjectRepository(VNetSubnetEntity)
    private readonly subnetRepository: Repository<VNetSubnetEntity>,
    @InjectRepository(VNetRouteEntity)
    private readonly routeRepository: Repository<VNetRouteEntity>,
    private readonly providerFactory: ProviderFactory,
    private readonly capabilitiesFactory: CapabilitiesProviderFactory,
  ) {}

  /**
   * Create a new VNet
   */
  async createVNet(createVNetDto: CreateVNetDto): Promise<VNetResponseDto> {
    this.logger.log(
      `Creating VNet: ${createVNetDto.name} on ${createVNetDto.provider}`,
    );

    // Get provider instance
    const provider = this.providerFactory.getProvider(createVNetDto.provider);

    // Verify provider supports VNet operations
    if (!provider.createVNet) {
      throw new BadRequestException(
        `Provider ${createVNetDto.provider} does not support VNet operations`,
      );
    }

    // Validate IP range prefix against provider-declared constraints
    const capabilities = this.capabilitiesFactory
      .getCapabilitiesService(createVNetDto.provider)
      .getStaticCapabilities();
    const ipRangeConstraints = capabilities.vnetTopology?.vnetIpRange;
    if (ipRangeConstraints) {
      const prefix = Number.parseInt(createVNetDto.ipRange.split('/')[1], 10);
      if (
        Number.isNaN(prefix) ||
        prefix < ipRangeConstraints.minPrefix ||
        prefix > ipRangeConstraints.maxPrefix
      ) {
        throw new BadRequestException(
          `IP range prefix /${prefix} is not valid for ${createVNetDto.provider}. ` +
            `Allowed range: /${ipRangeConstraints.minPrefix}–/${ipRangeConstraints.maxPrefix}.`,
        );
      }
    }

    // Prepare labels with standard Flui tags
    const labels = [
      { key: 'managed-by', value: 'flui-cloud' },
      { key: 'flui-resource-type', value: 'vnet' },
      { key: 'flui-vnet-name', value: createVNetDto.name },
      ...(createVNetDto.labels || []),
    ];

    // Add cluster ID label if provided in metadata
    if (createVNetDto.metadata?.clusterId) {
      labels.push({
        key: 'flui-cluster-id',
        value: createVNetDto.metadata.clusterId,
      });
    }

    try {
      // Create VNet on provider
      const result = await provider.createVNet({
        name: createVNetDto.name,
        ipRange: createVNetDto.ipRange,
        labels,
        subnets: createVNetDto.subnets?.map((subnet) => ({
          ipRange: subnet.ipRange,
          networkZone: subnet.networkZone,
          gateway: subnet.gateway,
          vswitchId: subnet.vswitchId,
        })),
        routes: createVNetDto.routes?.map((route) => ({
          destination: route.destination,
          gateway: route.gateway,
        })),
      });

      this.logger.log(
        `VNet created successfully with provider ID: ${result.vnetId}`,
      );

      // Create VNet entity
      const vnet = this.vnetRepository.create({
        providerResourceId: result.vnetId,
        name: createVNetDto.name,
        provider: createVNetDto.provider,
        ipRange: result.ipRange,
        labels,
        metadata: createVNetDto.metadata,
        status: VNetStatus.ACTIVE,
      });

      const savedVNet = await this.vnetRepository.save(vnet);

      // Create subnets
      if (result.subnets && result.subnets.length > 0) {
        const subnetEntities = result.subnets.map((subnet) =>
          this.subnetRepository.create({
            vnetId: savedVNet.id,
            providerSubnetId: subnet.id,
            ipRange: subnet.ipRange,
            type: SubnetType.CLOUD,
            networkZone: subnet.networkZone,
            gateway: subnet.gateway,
          }),
        );

        await this.subnetRepository.save(subnetEntities);
      }

      // Create routes
      if (createVNetDto.routes && createVNetDto.routes.length > 0) {
        const routeEntities = createVNetDto.routes.map((route) =>
          this.routeRepository.create({
            vnetId: savedVNet.id,
            destination: route.destination,
            gateway: route.gateway,
          }),
        );

        await this.routeRepository.save(routeEntities);
      }

      this.logger.log(`VNet ${createVNetDto.name} saved to database`);

      // Fetch complete VNet with relations
      return this.getVNet(savedVNet.id);
    } catch (error) {
      this.logger.error(
        `Failed to create VNet ${createVNetDto.name}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(`Failed to create VNet: ${error.message}`);
    }
  }

  /**
   * Import an existing VNet from provider without creating it
   * Used for reconciliation when VNet was created via CLI
   */
  async importVNet(importDto: {
    providerResourceId: string;
    provider: CloudProvider;
    name: string;
    ipRange: string;
    labels?: Array<{ key: string; value: string }>;
    metadata?: Record<string, any>;
  }): Promise<VNetResponseDto> {
    this.logger.log(
      `Importing VNet: ${importDto.name} from ${importDto.provider}`,
    );

    // Get provider instance
    const provider = this.providerFactory.getProvider(importDto.provider);

    if (!provider.getVNet) {
      throw new BadRequestException(
        `Provider ${importDto.provider} does not support VNet operations`,
      );
    }

    try {
      // Fetch VNet details from provider
      const providerVNet = await provider.getVNet(importDto.providerResourceId);

      if (!providerVNet) {
        throw new NotFoundException(
          `VNet ${importDto.providerResourceId} not found on provider`,
        );
      }

      // Check if VNet already exists in database
      const existingVNet = await this.vnetRepository.findOne({
        where: { providerResourceId: importDto.providerResourceId },
      });

      if (existingVNet) {
        this.logger.log(
          `VNet ${importDto.name} already exists in database, returning it`,
        );
        return this.getVNet(existingVNet.id);
      }

      // Create VNet entity
      const vnet = this.vnetRepository.create({
        providerResourceId: importDto.providerResourceId,
        name: importDto.name,
        provider: importDto.provider,
        ipRange: providerVNet.ipRange || importDto.ipRange,
        labels: importDto.labels || [],
        metadata: importDto.metadata,
        status: VNetStatus.ACTIVE,
      });

      const savedVNet = await this.vnetRepository.save(vnet);

      // Create subnets from provider data
      if (providerVNet.subnets && providerVNet.subnets.length > 0) {
        const subnetEntities = providerVNet.subnets.map((subnet) =>
          this.subnetRepository.create({
            vnetId: savedVNet.id,
            providerSubnetId: subnet.id,
            ipRange: subnet.ipRange,
            type: SubnetType.CLOUD,
            networkZone: subnet.networkZone,
            gateway: subnet.gateway,
          }),
        );

        await this.subnetRepository.save(subnetEntities);
      }

      this.logger.log(`VNet ${importDto.name} imported successfully`);

      return this.getVNet(savedVNet.id);
    } catch (error) {
      this.logger.error(
        `Failed to import VNet ${importDto.name}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(`Failed to import VNet: ${error.message}`);
    }
  }

  async registerManualVNet(input: {
    clusterId: string;
    provider: CloudProvider;
    name: string;
    ipRange: string;
  }): Promise<VNetResponseDto> {
    this.assertValidCidr(input.ipRange);

    const constraints = this.capabilitiesFactory
      .getCapabilitiesService(input.provider)
      .getStaticCapabilities().vnetTopology?.vnetIpRange;
    if (constraints) {
      const prefix = Number.parseInt(input.ipRange.split('/')[1], 10);
      if (
        Number.isNaN(prefix) ||
        prefix < constraints.minPrefix ||
        prefix > constraints.maxPrefix
      ) {
        throw new BadRequestException(
          `Private network prefix /${prefix} is out of range ` +
            `(/${constraints.minPrefix}–/${constraints.maxPrefix}).`,
        );
      }
    }

    const providerResourceId = `manual:${input.clusterId}`;
    const labels = [
      { key: 'managed-by', value: 'flui-cloud' },
      { key: 'flui-resource-type', value: 'vnet' },
      { key: 'flui-vnet-name', value: input.name },
      { key: 'flui-cluster-id', value: input.clusterId },
      { key: 'flui-vnet-scope', value: 'manual' },
    ];

    const existing = await this.vnetRepository.findOne({
      where: { providerResourceId },
      relations: ['subnets'],
    });
    if (existing) {
      if (existing.ipRange !== input.ipRange) {
        existing.ipRange = input.ipRange;
        await this.vnetRepository.save(existing);
      }
      const manualSubnet = (existing.subnets ?? []).find(
        (s) => s.type === SubnetType.MANUAL,
      );
      if (!manualSubnet) {
        await this.subnetRepository.save(
          this.buildManualSubnet(existing.id, input.ipRange),
        );
      } else if (manualSubnet.ipRange !== input.ipRange) {
        manualSubnet.ipRange = input.ipRange;
        await this.subnetRepository.save(manualSubnet);
      }
      this.logger.log(
        `Manual VNet for cluster ${input.clusterId} already registered; CIDR synced to ${input.ipRange}`,
      );
      return this.getVNet(existing.id);
    }

    const vnet = this.vnetRepository.create({
      providerResourceId,
      name: input.name,
      provider: input.provider,
      ipRange: input.ipRange,
      labels,
      status: VNetStatus.ACTIVE,
      metadata: { clusterId: input.clusterId, manual: true },
    });
    const savedVNet = await this.vnetRepository.save(vnet);
    await this.subnetRepository.save(
      this.buildManualSubnet(savedVNet.id, input.ipRange),
    );

    this.logger.log(
      `Registered manual VNet "${input.name}" (${input.ipRange}) for cluster ${input.clusterId}`,
    );
    return this.getVNet(savedVNet.id);
  }

  private buildManualSubnet(vnetId: string, ipRange: string): VNetSubnetEntity {
    return this.subnetRepository.create({
      vnetId,
      ipRange,
      type: SubnetType.MANUAL,
      networkZone: 'manual',
      attachedServerIds: [],
    });
  }

  private assertValidCidr(cidr: string): void {
    try {
      ipaddr.parseCIDR(cidr);
    } catch {
      throw new BadRequestException(
        `Invalid CIDR "${cidr}" — expected e.g. 10.0.0.0/24.`,
      );
    }
  }

  /**
   * Get VNet by ID
   */
  async getVNet(id: string): Promise<VNetResponseDto> {
    const vnet = await this.vnetRepository.findOne({
      where: { id },
      relations: ['subnets', 'routes'],
    });

    if (!vnet) {
      throw new NotFoundException(`VNet with ID ${id} not found`);
    }

    return this.toResponseDto(vnet);
  }

  /**
   * Get VNet by provider resource ID
   */
  async getVNetByProviderResourceId(
    providerResourceId: string,
  ): Promise<VNetResponseDto> {
    const vnet = await this.vnetRepository.findOne({
      where: { providerResourceId },
      relations: ['subnets', 'routes'],
    });

    if (!vnet) {
      throw new NotFoundException(
        `VNet with provider resource ID ${providerResourceId} not found`,
      );
    }

    return this.toResponseDto(vnet);
  }

  async ensureClusterIdLabel(vnetId: string, clusterId: string): Promise<void> {
    const vnet = await this.vnetRepository.findOne({ where: { id: vnetId } });
    if (!vnet) return;
    const labels = vnet.labels ?? [];
    if (
      labels.some((l) => l.key === 'flui-cluster-id' && l.value === clusterId)
    ) {
      return;
    }
    vnet.labels = [...labels, { key: 'flui-cluster-id', value: clusterId }];
    await this.vnetRepository.save(vnet);
  }

  /**
   * List all VNets
   */
  async listVNets(options?: {
    provider?: string;
    clusterId?: string;
  }): Promise<VNetListResponseDto> {
    const queryBuilder = this.vnetRepository
      .createQueryBuilder('vnet')
      .leftJoinAndSelect('vnet.subnets', 'subnets')
      .leftJoinAndSelect('vnet.routes', 'routes');

    if (options?.provider) {
      queryBuilder.andWhere('vnet.provider = :provider', {
        provider: options.provider,
      });
    }

    if (options?.clusterId) {
      queryBuilder.andWhere(
        "(vnet.metadata->>'clusterId' = :clusterId OR EXISTS (SELECT 1 FROM jsonb_array_elements(vnet.labels) AS label WHERE label->>'key' = 'flui-cluster-id' AND label->>'value' = :clusterId))",
        { clusterId: options.clusterId },
      );
    }

    const vnets = await queryBuilder.getMany();

    return {
      vnets: vnets.map((vnet) => this.toResponseDto(vnet)),
      total: vnets.length,
    };
  }

  /**
   * Delete VNet
   * Handles gracefully when VNet doesn't exist on provider (404)
   */
  async deleteVNet(id: string): Promise<void> {
    this.logger.log(`Deleting VNet: ${id}`);

    const vnet = await this.vnetRepository.findOne({
      where: { id },
      relations: ['subnets', 'routes'],
    });

    if (!vnet) {
      throw new NotFoundException(`VNet with ID ${id} not found`);
    }

    // Get provider instance
    const provider = this.providerFactory.getProvider(vnet.provider);

    // Verify provider supports VNet operations
    if (!provider.deleteVNet) {
      throw new BadRequestException(
        `Provider ${vnet.provider} does not support VNet operations`,
      );
    }

    try {
      // Check if any subnet has attached servers
      const subnetsWithServers = vnet.subnets.filter(
        (subnet) =>
          subnet.attachedServerIds && subnet.attachedServerIds.length > 0,
      );

      if (subnetsWithServers.length > 0) {
        const totalServers = subnetsWithServers.reduce(
          (sum, subnet) => sum + subnet.attachedServerIds.length,
          0,
        );
        throw new BadRequestException(
          `Cannot delete VNet ${id}: ${totalServers} server(s) are still attached to its subnets. ` +
            `Please detach all servers from subnets first using /subnets/{id}/detach-server endpoint.`,
        );
      }

      // Update status to deleting
      vnet.status = VNetStatus.DELETING;
      await this.vnetRepository.save(vnet);

      // Try to delete VNet from provider
      try {
        await provider.deleteVNet(vnet.providerResourceId);
        this.logger.log(`VNet ${id} deleted from provider`);
      } catch (providerError) {
        // Check if it's a 404 (VNet doesn't exist on provider)
        const is404 =
          providerError.message?.includes('404') ||
          providerError.message?.toLowerCase().includes('not found') ||
          providerError.statusCode === 404 ||
          providerError.status === 404;

        if (is404) {
          this.logger.warn(
            `VNet ${id} (provider ID: ${vnet.providerResourceId}) not found on provider. Proceeding with database cleanup.`,
          );
        } else {
          // Re-throw if it's not a 404
          throw providerError;
        }
      }

      // Delete from database (cascade will handle subnets and routes)
      await this.vnetRepository.remove(vnet);

      this.logger.log(`VNet ${id} deleted from database`);
    } catch (error) {
      this.logger.error(
        `Failed to delete VNet ${id}: ${error.message}`,
        error.stack,
      );

      // Update status to failed only if VNet still exists
      try {
        const stillExists = await this.vnetRepository.findOne({
          where: { id },
        });
        if (stillExists) {
          stillExists.status = VNetStatus.FAILED;
          await this.vnetRepository.save(stillExists);
        }
      } catch (saveError) {
        this.logger.error(`Failed to update VNet status: ${saveError.message}`);
      }

      throw new BadRequestException(`Failed to delete VNet: ${error.message}`);
    }
  }

  /**
   * Sync VNet from provider
   */
  async syncVNet(id: string): Promise<VNetResponseDto> {
    this.logger.log(`Syncing VNet ${id} from provider`);

    const vnet = await this.vnetRepository.findOne({
      where: { id },
      relations: ['subnets', 'routes'],
    });

    if (!vnet) {
      throw new NotFoundException(`VNet with ID ${id} not found`);
    }

    const provider = this.providerFactory.getProvider(vnet.provider);

    if (!provider.getVNet) {
      throw new BadRequestException(
        `Provider ${vnet.provider} does not support VNet operations`,
      );
    }

    try {
      const providerVNet = await provider.getVNet(vnet.providerResourceId);

      if (!providerVNet) {
        throw new NotFoundException(`VNet ${id} not found on provider`);
      }

      // Update subnets
      if (providerVNet.subnets) {
        // Remove old subnets
        await this.subnetRepository.delete({ vnetId: id });

        // Create new subnets
        const subnetEntities = providerVNet.subnets.map((subnet) =>
          this.subnetRepository.create({
            vnetId: id,
            providerSubnetId: subnet.id,
            ipRange: subnet.ipRange,
            type: SubnetType.CLOUD,
            networkZone: subnet.networkZone,
            gateway: subnet.gateway,
          }),
        );

        await this.subnetRepository.save(subnetEntities);
      }

      this.logger.log(`VNet ${id} synced successfully`);

      return this.getVNet(id);
    } catch (error) {
      this.logger.error(
        `Failed to sync VNet ${id}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(`Failed to sync VNet: ${error.message}`);
    }
  }

  /**
   * Add subnet to VNet
   */
  async addSubnetToVNet(
    vnetId: string,
    addSubnetDto: AddSubnetDto,
  ): Promise<VNetResponseDto> {
    this.logger.log(`Adding subnet to VNet ${vnetId}`);

    const vnet = await this.vnetRepository.findOne({
      where: { id: vnetId },
      relations: ['subnets', 'routes'],
    });

    if (!vnet) {
      throw new NotFoundException(`VNet with ID ${vnetId} not found`);
    }

    const provider = this.providerFactory.getProvider(vnet.provider);

    if (!provider.addSubnet) {
      throw new BadRequestException(
        `Provider ${vnet.provider} does not support subnet operations`,
      );
    }

    try {
      // Calculate IP range if not provided
      let ipRange = addSubnetDto.ipRange;
      if (!ipRange) {
        this.logger.log(
          'No IP range specified, calculating next available /28 subnet (16 IPs)...',
        );

        const existingSubnetRanges = vnet.subnets.map((s) => s.ipRange);
        ipRange = SubnetCalculator.calculateNextSubnetRange(
          vnet.ipRange,
          existingSubnetRanges,
          28, // Default to /28 subnet (16 IP addresses)
        );

        if (!ipRange) {
          throw new BadRequestException(
            'No available IP space for new subnet. Please specify an IP range manually.',
          );
        }

        this.logger.log(`Auto-calculated subnet range: ${ipRange}`);
      } else {
        // Validate provided IP range is within VNet range
        if (!SubnetCalculator.validateSubnetInRange(vnet.ipRange, ipRange)) {
          throw new BadRequestException(
            `Subnet range ${ipRange} is not within VNet range ${vnet.ipRange}`,
          );
        }

        // Check for overlaps with existing subnets
        for (const existingSubnet of vnet.subnets) {
          if (
            SubnetCalculator.doSubnetsOverlap(ipRange, existingSubnet.ipRange)
          ) {
            throw new BadRequestException(
              `Subnet range ${ipRange} overlaps with existing subnet ${existingSubnet.ipRange}`,
            );
          }
        }
      }

      // Add subnet on provider
      const result = (await provider.addSubnet({
        vnetId: vnet.providerResourceId,
        ipRange,
        networkZone: addSubnetDto.networkZone || 'eu-central',
        vswitchId: addSubnetDto.vswitchId,
      })) as AddSubnetResult;

      this.logger.log(`Subnet added to provider with ID: ${result.subnetId}`);

      // Create subnet entity
      const subnet = this.subnetRepository.create({
        vnetId: vnet.id,
        providerSubnetId: result.subnetId,
        ipRange: result.ipRange,
        networkZone: result.networkZone,
        gateway: result.gateway,
        vswitchId: addSubnetDto.vswitchId,
      });

      await this.subnetRepository.save(subnet);

      this.logger.log(`Subnet saved to database`);

      return this.getVNet(vnetId);
    } catch (error) {
      this.logger.error(
        `Failed to add subnet to VNet ${vnetId}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(`Failed to add subnet: ${error.message}`);
    }
  }

  /**
   * Delete subnet from VNet
   */
  async deleteSubnetFromVNet(
    vnetId: string,
    deleteSubnetDto: DeleteSubnetDto,
  ): Promise<VNetResponseDto> {
    this.logger.log(
      `Deleting subnet ${deleteSubnetDto.subnetId} from VNet ${vnetId}`,
    );

    const vnet = await this.vnetRepository.findOne({
      where: { id: vnetId },
      relations: ['subnets', 'routes'],
    });

    if (!vnet) {
      throw new NotFoundException(`VNet with ID ${vnetId} not found`);
    }

    const subnet = vnet.subnets.find(
      (s) => s.providerSubnetId === deleteSubnetDto.subnetId,
    );

    if (!subnet) {
      throw new NotFoundException(
        `Subnet ${deleteSubnetDto.subnetId} not found in VNet ${vnetId}`,
      );
    }

    const provider = this.providerFactory.getProvider(vnet.provider);

    if (!provider.deleteSubnet) {
      throw new BadRequestException(
        `Provider ${vnet.provider} does not support subnet operations`,
      );
    }

    try {
      // Delete subnet from provider
      await provider.deleteSubnet({
        vnetId: vnet.providerResourceId,
        ipRange: subnet.ipRange,
      });

      this.logger.log(
        `Subnet ${deleteSubnetDto.subnetId} deleted from provider`,
      );

      // Delete from database
      await this.subnetRepository.remove(subnet);

      this.logger.log(
        `Subnet ${deleteSubnetDto.subnetId} deleted from database`,
      );

      return this.getVNet(vnetId);
    } catch (error) {
      this.logger.error(
        `Failed to delete subnet ${deleteSubnetDto.subnetId} from VNet ${vnetId}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to delete subnet: ${error.message}`,
      );
    }
  }

  /**
   * Convert VNet entity to response DTO
   */
  private toResponseDto(vnet: VNetEntity): VNetResponseDto {
    return {
      id: vnet.id,
      providerResourceId: vnet.providerResourceId,
      name: vnet.name,
      provider: vnet.provider,
      ipRange: vnet.ipRange,
      labels: vnet.labels,
      metadata: vnet.metadata,
      status: vnet.status,
      subnets: vnet.subnets.map((subnet) => ({
        id: subnet.id,
        providerSubnetId: subnet.providerSubnetId,
        ipRange: subnet.ipRange,
        networkZone: subnet.networkZone,
        gateway: subnet.gateway,
        vswitchId: subnet.vswitchId,
        attachedServerIds: subnet.attachedServerIds || [],
        createdAt: subnet.createdAt,
        updatedAt: subnet.updatedAt,
      })),
      routes: vnet.routes.map((route) => ({
        id: route.id,
        destination: route.destination,
        gateway: route.gateway,
        createdAt: route.createdAt,
        updatedAt: route.updatedAt,
      })),
      createdAt: vnet.createdAt,
      updatedAt: vnet.updatedAt,
    };
  }
}
