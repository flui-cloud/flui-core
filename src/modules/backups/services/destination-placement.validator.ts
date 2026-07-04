import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';

/**
 * A backup must survive the loss of the cluster's own provider. Reject a
 * destination that lives on the same cloud as the cluster (single failure
 * domain). MinIO/Generic-S3 targets carry no determinable provider, so they
 * pass with a warning rather than a hard block.
 */
@Injectable()
export class DestinationPlacementValidator {
  private readonly logger = new Logger(DestinationPlacementValidator.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly destRepo: BackupDestinationRepository,
  ) {}

  async assertOffProvider(
    clusterId: string,
    destinationId: string,
  ): Promise<void> {
    const [cluster, dest] = await Promise.all([
      this.clusterRepo.findOne({ where: { id: clusterId } }),
      this.destRepo.findById(destinationId),
    ]);
    if (!cluster || !dest) return;

    const destFamily = this.cloudFamilyOf(dest.provider);
    if (!destFamily) {
      this.logger.warn(
        `[placement] destination ${destinationId} provider=${dest.provider} has no determinable cloud family — off-provider guarantee not verifiable`,
      );
      return;
    }
    if (destFamily === (cluster.provider ?? '').toLowerCase()) {
      throw new BadRequestException(
        `Backup destination is on the same provider (${destFamily}) as its cluster. A provider-wide outage would take down both the workload and its backup. Choose a destination on a different provider.`,
      );
    }
  }

  /**
   * Strict variant for the platform (master) backup class: the destination MUST
   * be off the master's own provider. Unlike the lenient check, an opaque
   * (MinIO / generic-S3) destination is REJECTED unless the operator has
   * attested `offProviderAck` — a master backup that dies with the master is
   * worthless. `controlProvider` is the control cluster's provider family.
   */
  async assertOffProviderStrict(
    controlProvider: string | null | undefined,
    destinationId: string,
  ): Promise<void> {
    const dest = await this.destRepo.findById(destinationId);
    if (!dest) {
      throw new BadRequestException(`Destination ${destinationId} not found`);
    }
    const control = (controlProvider ?? '').toLowerCase();
    const destFamily = this.cloudFamilyOf(dest.provider);

    if (!destFamily) {
      if (!dest.offProviderAck) {
        throw new BadRequestException(
          `Destination ${destinationId} (${dest.provider}) has no determinable provider, so Flui cannot verify it is off the master's own provider. ` +
            `Re-register it with off-provider acknowledgement (--ack-off-provider) once you have confirmed the endpoint is NOT hosted on the master's provider.`,
        );
      }
      return;
    }
    if (!control) {
      this.logger.warn(
        `[placement] control cluster provider unknown — cannot verify platform destination ${destinationId} is off-provider`,
      );
      return;
    }
    if (destFamily === control) {
      throw new BadRequestException(
        `Platform backup destination is on the same provider (${destFamily}) as the master/control cluster. A provider-wide outage would take down the master AND its only recovery bundle. Choose a destination on a different provider.`,
      );
    }
  }

  private cloudFamilyOf(provider: StorageBackendProvider): string | null {
    switch (provider) {
      case StorageBackendProvider.SCALEWAY_OBJECT_STORAGE:
        return 'scaleway';
      case StorageBackendProvider.HETZNER_OBJECT_STORAGE:
        return 'hetzner';
      default:
        return null;
    }
  }
}
