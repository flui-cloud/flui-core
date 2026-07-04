import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as dnsPromises from 'node:dns/promises';
import { DnsZoneEntity } from '../entities/dns-zone.entity';
import { CreateDnsZoneDto } from '../dto/create-dns-zone.dto';
import { DnsZoneResponseDto } from '../dto/dns-zone-response.dto';
import { DnsLookupResponseDto } from '../dto/dns-lookup-response.dto';
import { DnsProviderFactory } from '../../providers/services/dns-provider.factory';
import { DnsZoneInfo } from '../../providers/interfaces/dns-provider.interface';
import { DnsProvider } from '../../providers/enums/dns-provider.enum';

@Injectable()
export class DnsZoneService {
  private readonly logger = new Logger(DnsZoneService.name);

  constructor(
    @InjectRepository(DnsZoneEntity)
    private readonly dnsZoneRepository: Repository<DnsZoneEntity>,
    private readonly dnsProviderFactory: DnsProviderFactory,
  ) {}

  async createZone(dto: CreateDnsZoneDto): Promise<DnsZoneEntity> {
    this.logger.log(
      `Creating DNS zone ${dto.zoneName} on provider ${dto.dnsProvider}`,
    );

    const dnsProvider = this.dnsProviderFactory.getDnsProviderOrFail(
      dto.dnsProvider,
    );

    let providerZoneId = dto.providerZoneId;

    if (!providerZoneId) {
      const zone = await dnsProvider.getZoneByName(dto.zoneName);
      if (!zone) {
        throw new BadRequestException(
          `Zone ${dto.zoneName} not found in provider ${dto.dnsProvider}. ` +
            `Make sure the zone exists in your DNS provider account before registering it here.`,
        );
      }
      providerZoneId = zone.zoneId;
    }

    const existing = await this.dnsZoneRepository.findOne({
      where: { providerZoneId, dnsProvider: dto.dnsProvider },
    });

    if (existing) {
      throw new ConflictException(
        `DNS zone ${dto.zoneName} (${providerZoneId}) is already registered for provider ${dto.dnsProvider}`,
      );
    }

    const zone = this.dnsZoneRepository.create({
      providerZoneId,
      zoneName: dto.zoneName,
      dnsProvider: dto.dnsProvider,
      description: dto.description ?? null,
    });

    return await this.dnsZoneRepository.save(zone);
  }

  async listZones(): Promise<DnsZoneEntity[]> {
    return await this.dnsZoneRepository.find();
  }

  async getZone(id: string): Promise<DnsZoneEntity> {
    const zone = await this.dnsZoneRepository.findOne({ where: { id } });

    if (!zone) {
      throw new NotFoundException(`DNS zone with ID ${id} not found`);
    }

    return zone;
  }

  async deleteZone(id: string): Promise<void> {
    const zone = await this.dnsZoneRepository.findOne({
      where: { id },
      relations: ['clusterAssignments'],
    });

    if (!zone) {
      throw new NotFoundException(`DNS zone with ID ${id} not found`);
    }

    if (zone.clusterAssignments && zone.clusterAssignments.length > 0) {
      throw new ConflictException(
        `DNS zone ${zone.zoneName} is still assigned to ${zone.clusterAssignments.length} cluster(s). ` +
          `Remove the cluster assignments before deleting the zone.`,
      );
    }

    await this.dnsZoneRepository.remove(zone);
    this.logger.log(`Deleted DNS zone ${zone.zoneName} (${id})`);
  }

  getSupportedDnsProviders(): import('../../providers/enums/dns-provider.enum').DnsProvider[] {
    return this.dnsProviderFactory.getSupportedProviders();
  }

  async listProviderZones(provider: DnsProvider): Promise<DnsZoneInfo[]> {
    const dnsProvider = this.dnsProviderFactory.getDnsProviderOrFail(provider);
    return await dnsProvider.listZones();
  }

  async verifyDnsResolution(
    hostname: string,
    expectedIp: string,
  ): Promise<DnsLookupResponseDto> {
    let resolvedAddresses: string[] = [];

    try {
      resolvedAddresses = await dnsPromises.resolve4(hostname);
    } catch {
      // NXDOMAIN, ENOTFOUND, etc. — hostname does not resolve
    }

    return {
      hostname,
      expectedIp,
      resolvedAddresses,
      matches: resolvedAddresses.includes(expectedIp),
    };
  }

  toResponseDto(zone: DnsZoneEntity): DnsZoneResponseDto {
    return {
      id: zone.id,
      providerZoneId: zone.providerZoneId,
      zoneName: zone.zoneName,
      dnsProvider: zone.dnsProvider,
      description: zone.description,
      recordTtlSeconds: zone.recordTtlSeconds,
      replicas: (zone.replicas ?? []).map((r) => ({
        id: r.id,
        dnsZoneId: r.dnsZoneId,
        dnsProvider: r.dnsProvider,
        providerZoneId: r.providerZoneId,
        status: r.status,
        lastReconciledAt: r.lastReconciledAt ?? null,
        errorMessage: r.errorMessage ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      createdAt: zone.createdAt,
      updatedAt: zone.updatedAt,
    };
  }
}
