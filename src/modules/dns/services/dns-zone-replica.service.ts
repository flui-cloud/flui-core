import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DnsProviderFactory } from '../../providers/core/factories/dns-provider.factory';
import { DnsProvider } from '../../providers/enums/dns-provider.enum';
import { DnsZoneEntity } from '../entities/dns-zone.entity';
import { DnsZoneReplicaEntity } from '../entities/dns-zone-replica.entity';
import { DnsReplicaStatus } from '../enums/dns-replica-status.enum';
import { DnsZoneReplicaResponseDto } from '../dto/dns-zone-replica-response.dto';
import { RegisterDnsReplicaDto } from '../dto/register-dns-replica.dto';
import {
  DnsZoneReconciliationService,
  ReplicaDiffReport,
} from './dns-zone-reconciliation.service';

/** Default TTL for a single-provider zone; restored when redundancy is removed. */
const DEFAULT_ZONE_TTL = 300;
/** Failover TTL applied when redundancy is enabled (override via DNS_FAILOVER_TTL). */
const FAILOVER_TTL_DEFAULT = 60;
const FAILOVER_TTL_FLOOR = 60;

/**
 * Lifecycle of the redundancy replicas of a logical DNS zone: register a second
 * provider, populate it from Flui state, dry-run verify, disable, remove. A
 * zone's primary provider stays untouched; a replica only ever adds coverage.
 */
@Injectable()
export class DnsZoneReplicaService {
  private readonly logger = new Logger(DnsZoneReplicaService.name);

  constructor(
    @InjectRepository(DnsZoneEntity)
    private readonly zoneRepo: Repository<DnsZoneEntity>,
    @InjectRepository(DnsZoneReplicaEntity)
    private readonly replicaRepo: Repository<DnsZoneReplicaEntity>,
    private readonly dnsProviderFactory: DnsProviderFactory,
    private readonly reconciliation: DnsZoneReconciliationService,
  ) {}

  async listReplicas(zoneId: string): Promise<DnsZoneReplicaEntity[]> {
    await this.getZoneOrFail(zoneId);
    return this.replicaRepo.find({
      where: { dnsZoneId: zoneId },
      order: { createdAt: 'ASC' },
    });
  }

  async registerReplica(
    zoneId: string,
    dto: RegisterDnsReplicaDto,
  ): Promise<DnsZoneReplicaEntity> {
    const zone = await this.getZoneOrFail(zoneId);
    this.assertReplicaProviderValid(zone, dto.dnsProvider);

    const providerZoneId = await this.resolveReplicaProviderZoneId(zone, dto);
    const isFirstReplica = (zone.replicas?.length ?? 0) === 0;

    const replica = this.replicaRepo.create({
      dnsZoneId: zone.id,
      dnsProvider: dto.dnsProvider,
      providerZoneId,
      status: DnsReplicaStatus.PENDING,
    });
    const saved = await this.replicaRepo.save(replica);

    // Lower the zone TTL to the failover value the first time redundancy is added.
    if (isFirstReplica) {
      const ttl = this.failoverTtl();
      if (zone.recordTtlSeconds > ttl) {
        await this.zoneRepo.update(zone.id, { recordTtlSeconds: ttl });
      }
    }

    this.logger.log(
      `Registered DNS replica ${dto.dnsProvider} (${providerZoneId}) for zone ${zone.zoneName}`,
    );
    return saved;
  }

  private assertReplicaProviderValid(
    zone: DnsZoneEntity,
    provider: DnsProvider,
  ): void {
    if (zone.dnsProvider === DnsProvider.NONE) {
      throw new BadRequestException(
        'This zone is not provider-backed (nip.io / manual records) — DNS replicas are not supported.',
      );
    }
    if (provider === DnsProvider.NONE) {
      throw new BadRequestException(
        'A replica must target a real DNS provider.',
      );
    }
    if (provider === zone.dnsProvider) {
      throw new BadRequestException(
        'A replica must use a different provider than the primary zone.',
      );
    }
    if (!this.dnsProviderFactory.supportsDns(provider)) {
      throw new BadRequestException(
        `DNS provider ${provider} is not configured on this installation.`,
      );
    }
    if (zone.replicas?.some((r) => r.dnsProvider === provider)) {
      throw new ConflictException(
        `A replica on provider ${provider} is already registered for this zone.`,
      );
    }
  }

  /** Resolve (and validate) the provider-side zone id for a new replica. */
  private async resolveReplicaProviderZoneId(
    zone: DnsZoneEntity,
    dto: RegisterDnsReplicaDto,
  ): Promise<string> {
    const provider = this.dnsProviderFactory.getDnsProviderOrFail(
      dto.dnsProvider,
    );

    if (!dto.providerZoneId) {
      const found = await provider.getZoneByName(zone.zoneName);
      if (!found) {
        throw new BadRequestException(
          `Zone ${zone.zoneName} not found in provider ${dto.dnsProvider}. ` +
            `Create the zone in the provider account first, then register it as a replica.`,
        );
      }
      return found.zoneId;
    }

    const found = await provider.getZone(dto.providerZoneId);
    if (!found) {
      throw new BadRequestException(
        `Zone ${dto.providerZoneId} not found in provider ${dto.dnsProvider}.`,
      );
    }
    // A replica must publish the SAME domain — otherwise fan-out writes into an
    // unrelated zone and the orphan sweep could delete its records.
    if (found.name !== zone.zoneName) {
      throw new BadRequestException(
        `Provider zone ${dto.providerZoneId} is "${found.name}", not "${zone.zoneName}". ` +
          `A replica must publish the same domain as the primary zone.`,
      );
    }
    return dto.providerZoneId;
  }

  /** Fan every current record into the replica; ACTIVE on success, PENDING on failure. */
  async populateReplica(
    zoneId: string,
    replicaId: string,
  ): Promise<ReplicaDiffReport> {
    const { zone, replica } = await this.getReplicaOrFail(zoneId, replicaId);

    await this.replicaRepo.update(replica.id, {
      status: DnsReplicaStatus.POPULATING,
      errorMessage: null,
    });

    const plan = await this.reconciliation.buildExpectation(zone);
    const report = await this.reconciliation.reconcileTarget(
      {
        dnsProvider: replica.dnsProvider,
        providerZoneId: replica.providerZoneId,
      },
      plan,
    );

    const clean = report.errors.length === 0;
    await this.replicaRepo.update(replica.id, {
      status: clean ? DnsReplicaStatus.ACTIVE : DnsReplicaStatus.PENDING,
      lastReconciledAt: new Date(),
      errorMessage: clean ? null : report.errors.join('; ').slice(0, 2000),
    });
    return report;
  }

  /** Dry-run diff — no mutations. Run this (plus an out-of-band `dig @ns`) before touching the registrar. */
  async verifyReplica(
    zoneId: string,
    replicaId: string,
  ): Promise<ReplicaDiffReport> {
    const { zone, replica } = await this.getReplicaOrFail(zoneId, replicaId);
    const plan = await this.reconciliation.buildExpectation(zone);
    return this.reconciliation.reconcileTarget(
      {
        dnsProvider: replica.dnsProvider,
        providerZoneId: replica.providerZoneId,
      },
      plan,
      { dryRun: true },
    );
  }

  async setReplicaDisabled(
    zoneId: string,
    replicaId: string,
    disabled: boolean,
  ): Promise<DnsZoneReplicaEntity> {
    const { replica } = await this.getReplicaOrFail(zoneId, replicaId);
    // Re-enabling a never-populated replica goes back to PENDING (needs populate),
    // not straight to ACTIVE.
    const enabledStatus = replica.lastReconciledAt
      ? DnsReplicaStatus.ACTIVE
      : DnsReplicaStatus.PENDING;
    await this.replicaRepo.update(replica.id, {
      status: disabled ? DnsReplicaStatus.DISABLED : enabledStatus,
      errorMessage: null,
    });
    return this.replicaRepo.findOneOrFail({ where: { id: replica.id } });
  }

  /** Removes only the Flui registration — provider records are left in place. */
  async removeReplica(zoneId: string, replicaId: string): Promise<void> {
    const { zone, replica } = await this.getReplicaOrFail(zoneId, replicaId);
    await this.replicaRepo.remove(replica);

    // Removing the last replica ends redundancy — restore the default TTL.
    const remaining = await this.replicaRepo.count({
      where: { dnsZoneId: zoneId },
    });
    if (remaining === 0 && zone.recordTtlSeconds !== DEFAULT_ZONE_TTL) {
      await this.zoneRepo.update(zoneId, {
        recordTtlSeconds: DEFAULT_ZONE_TTL,
      });
    }

    this.logger.log(
      `Removed DNS replica ${replica.dnsProvider} from zone ${zoneId} (provider records left in place)`,
    );
  }

  toResponseDto(replica: DnsZoneReplicaEntity): DnsZoneReplicaResponseDto {
    return {
      id: replica.id,
      dnsZoneId: replica.dnsZoneId,
      dnsProvider: replica.dnsProvider,
      providerZoneId: replica.providerZoneId,
      status: replica.status,
      lastReconciledAt: replica.lastReconciledAt ?? null,
      errorMessage: replica.errorMessage ?? null,
      createdAt: replica.createdAt,
      updatedAt: replica.updatedAt,
    };
  }

  private failoverTtl(): number {
    const raw = Number.parseInt(process.env.DNS_FAILOVER_TTL ?? '', 10);
    const ttl = Number.isFinite(raw) && raw > 0 ? raw : FAILOVER_TTL_DEFAULT;
    // Floor at 60: both Hetzner and Scaleway clamp TTL up to 60s, so a lower
    // value would make the reconciler thrash trying to re-lower it every run.
    return Math.max(FAILOVER_TTL_FLOOR, ttl);
  }

  private async getZoneOrFail(zoneId: string): Promise<DnsZoneEntity> {
    const zone = await this.zoneRepo.findOne({ where: { id: zoneId } });
    if (!zone) {
      throw new NotFoundException(`DNS zone with ID ${zoneId} not found`);
    }
    return zone;
  }

  private async getReplicaOrFail(
    zoneId: string,
    replicaId: string,
  ): Promise<{ zone: DnsZoneEntity; replica: DnsZoneReplicaEntity }> {
    const zone = await this.getZoneOrFail(zoneId);
    const replica = await this.replicaRepo.findOne({
      where: { id: replicaId, dnsZoneId: zoneId },
    });
    if (!replica) {
      throw new NotFoundException(
        `DNS replica ${replicaId} not found on zone ${zoneId}`,
      );
    }
    return { zone, replica };
  }
}
