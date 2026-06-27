import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VNetSubnetEntity, SubnetType } from '../entities/vnet-subnet.entity';
import { VNetEntity } from '../entities/vnet.entity';
import { ProviderFactory } from 'src/modules/providers/services/provider.factory';
import {
  AttachServerToSubnetDto,
  DetachServerFromSubnetDto,
} from '../dto/attach-server-to-subnet.dto';
import {
  SubnetResponseDto,
  SubnetListResponseDto,
} from '../dto/subnet-response.dto';
import * as ipaddr from 'ipaddr.js';

@Injectable()
export class SubnetsService {
  private readonly logger = new Logger(SubnetsService.name);

  constructor(
    @InjectRepository(VNetSubnetEntity)
    private readonly subnetRepository: Repository<VNetSubnetEntity>,
    @InjectRepository(VNetEntity)
    private readonly vnetRepository: Repository<VNetEntity>,
    private readonly providerFactory: ProviderFactory,
  ) {}

  /**
   * Get subnet by ID
   */
  async getSubnet(id: string): Promise<SubnetResponseDto> {
    const subnet = await this.subnetRepository.findOne({
      where: { id },
      relations: ['vnet'],
    });

    if (!subnet) {
      throw new NotFoundException(`Subnet with ID ${id} not found`);
    }

    return this.toResponseDto(subnet);
  }

  /**
   * List all subnets
   */
  async listSubnets(options?: {
    vnetId?: string;
    provider?: string;
  }): Promise<SubnetListResponseDto> {
    const queryBuilder = this.subnetRepository
      .createQueryBuilder('subnet')
      .leftJoinAndSelect('subnet.vnet', 'vnet');

    if (options?.vnetId) {
      queryBuilder.andWhere('subnet.vnetId = :vnetId', {
        vnetId: options.vnetId,
      });
    }

    if (options?.provider) {
      queryBuilder.andWhere('vnet.provider = :provider', {
        provider: options.provider,
      });
    }

    const subnets = await queryBuilder.getMany();

    return {
      subnets: subnets.map((subnet) => this.toResponseDto(subnet)),
      total: subnets.length,
    };
  }

  /**
   * Attach server to a specific subnet
   */
  async attachServerToSubnet(
    subnetId: string,
    attachDto: AttachServerToSubnetDto,
  ): Promise<SubnetResponseDto> {
    this.logger.log(
      `Attaching server ${attachDto.serverId} to subnet ${subnetId}`,
    );

    const subnet = await this.subnetRepository.findOne({
      where: { id: subnetId },
      relations: ['vnet'],
    });

    if (!subnet) {
      throw new NotFoundException(`Subnet with ID ${subnetId} not found`);
    }

    if (subnet.type === SubnetType.MANUAL) {
      if (attachDto.ip && !this.isIpInSubnet(attachDto.ip, subnet.ipRange)) {
        throw new BadRequestException(
          `IP ${attachDto.ip} is not within the private network ${subnet.ipRange}`,
        );
      }
      if (!subnet.attachedServerIds) {
        subnet.attachedServerIds = [];
      }
      if (!subnet.attachedServerIds.includes(attachDto.serverId)) {
        subnet.attachedServerIds.push(attachDto.serverId);
        await this.subnetRepository.save(subnet);
      }
      this.logger.log(
        `Recorded server ${attachDto.serverId} on manual subnet ${subnetId} (${subnet.ipRange})`,
      );
      return this.getSubnet(subnetId);
    }

    const vnet = subnet.vnet;
    const provider = this.providerFactory.getProvider(vnet.provider);

    if (!provider.attachServerToVNet) {
      throw new BadRequestException(
        `Provider ${vnet.provider} does not support server attachment`,
      );
    }

    try {
      // Validate IP is within subnet range if provided
      const ipToAssign = attachDto.ip;
      if (ipToAssign) {
        if (!this.isIpInSubnet(ipToAssign, subnet.ipRange)) {
          throw new BadRequestException(
            `IP ${ipToAssign} is not within subnet range ${subnet.ipRange}`,
          );
        }
      }

      // Validate alias IPs are within subnet range
      if (attachDto.aliasIps && attachDto.aliasIps.length > 0) {
        for (const aliasIp of attachDto.aliasIps) {
          if (!this.isIpInSubnet(aliasIp, subnet.ipRange)) {
            throw new BadRequestException(
              `Alias IP ${aliasIp} is not within subnet range ${subnet.ipRange}`,
            );
          }
        }
      }

      // Attach server to VNet via provider
      // Note: We pass the VNet ID to the provider, but specify the IP from the subnet
      await provider.attachServerToVNet({
        serverId: attachDto.serverId,
        vnetId: vnet.providerResourceId,
        ip: ipToAssign,
        aliasIps: attachDto.aliasIps,
      });

      // Update subnet's attached server IDs
      if (!subnet.attachedServerIds) {
        subnet.attachedServerIds = [];
      }

      if (!subnet.attachedServerIds.includes(attachDto.serverId)) {
        subnet.attachedServerIds.push(attachDto.serverId);
        await this.subnetRepository.save(subnet);
      }

      this.logger.log(
        `Server ${attachDto.serverId} attached to subnet ${subnetId}`,
      );

      return this.getSubnet(subnetId);
    } catch (error) {
      this.logger.error(
        `Failed to attach server ${attachDto.serverId} to subnet ${subnetId}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to attach server to subnet: ${error.message}`,
      );
    }
  }

  /**
   * Detach server from a specific subnet
   */
  async detachServerFromSubnet(
    subnetId: string,
    detachDto: DetachServerFromSubnetDto,
  ): Promise<SubnetResponseDto> {
    this.logger.log(
      `Detaching server ${detachDto.serverId} from subnet ${subnetId}`,
    );

    const subnet = await this.subnetRepository.findOne({
      where: { id: subnetId },
      relations: ['vnet'],
    });

    if (!subnet) {
      throw new NotFoundException(`Subnet with ID ${subnetId} not found`);
    }

    if (subnet.type === SubnetType.MANUAL) {
      subnet.attachedServerIds = (subnet.attachedServerIds ?? []).filter(
        (id) => id !== detachDto.serverId,
      );
      await this.subnetRepository.save(subnet);
      this.logger.log(
        `Removed server ${detachDto.serverId} from manual subnet ${subnetId}`,
      );
      return this.getSubnet(subnetId);
    }

    const vnet = subnet.vnet;
    const provider = this.providerFactory.getProvider(vnet.provider);

    if (!provider.detachServerFromVNet) {
      throw new BadRequestException(
        `Provider ${vnet.provider} does not support server detachment`,
      );
    }

    try {
      // Detach server from VNet via provider
      await provider.detachServerFromVNet({
        serverId: detachDto.serverId,
        vnetId: vnet.providerResourceId,
      });

      // Update subnet's attached server IDs
      subnet.attachedServerIds = subnet.attachedServerIds.filter(
        (id) => id !== detachDto.serverId,
      );
      await this.subnetRepository.save(subnet);

      this.logger.log(
        `Server ${detachDto.serverId} detached from subnet ${subnetId}`,
      );

      return this.getSubnet(subnetId);
    } catch (error) {
      this.logger.error(
        `Failed to detach server ${detachDto.serverId} from subnet ${subnetId}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to detach server from subnet: ${error.message}`,
      );
    }
  }

  /**
   * Check if an IP address is within a subnet range
   */
  private isIpInSubnet(ip: string, cidr: string): boolean {
    try {
      const subnet = ipaddr.parseCIDR(cidr);
      const address = ipaddr.parse(ip);

      // Check if both are IPv4
      if (address.kind() !== 'ipv4' || subnet[0].kind() !== 'ipv4') {
        return false;
      }

      // TypeScript doesn't know that both are IPv4, so we need to cast
      const ipv4Address = address as ipaddr.IPv4;
      const ipv4Subnet = subnet as [ipaddr.IPv4, number];

      return ipv4Address.match(ipv4Subnet);
    } catch (error) {
      this.logger.error(
        `Failed to validate IP ${ip} against CIDR ${cidr}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Convert subnet entity to response DTO
   */
  private toResponseDto(subnet: VNetSubnetEntity): SubnetResponseDto {
    return {
      id: subnet.id,
      vnetId: subnet.vnetId,
      providerSubnetId: subnet.providerSubnetId,
      ipRange: subnet.ipRange,
      type: subnet.type,
      networkZone: subnet.networkZone,
      gateway: subnet.gateway,
      vswitchId: subnet.vswitchId,
      attachedServerIds: subnet.attachedServerIds || [],
      createdAt: subnet.createdAt,
      updatedAt: subnet.updatedAt,
    };
  }
}
