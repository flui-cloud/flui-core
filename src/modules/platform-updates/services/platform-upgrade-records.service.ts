import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InfrastructureOperationEntity } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  PlatformUpgradeMetadata,
  UpgradePhaseCluster,
  UpgradePhaseKey,
  isUpgradeMetadata,
} from '../interfaces/platform-upgrade.interface';
import { phaseOf } from '../utils/upgrade-state.util';

export interface LoadedUpgrade {
  operation: InfrastructureOperationEntity;
  metadata: PlatformUpgradeMetadata;
}

/** The operation row a planned platform update records its progress in. */
@Injectable()
export class PlatformUpgradeRecordsService {
  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
  ) {}

  async load(operationId: string): Promise<LoadedUpgrade | null> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });
    if (!operation || !isUpgradeMetadata(operation.metadata)) return null;
    return { operation, metadata: operation.metadata };
  }

  /** Re-read before every write: K3s writes its own state into the same row. */
  async mutate(
    operationId: string,
    change: (
      metadata: PlatformUpgradeMetadata,
      operation: InfrastructureOperationEntity,
    ) => void,
  ): Promise<void> {
    const loaded = await this.load(operationId);
    if (!loaded) return;
    change(loaded.metadata, loaded.operation);
    loaded.operation.metadata = loaded.metadata;
    await this.operationRepository.save(loaded.operation);
  }

  markCluster(
    operationId: string,
    key: UpgradePhaseKey,
    clusterId: string,
    patch: Partial<UpgradePhaseCluster>,
  ): Promise<void> {
    return this.mutate(operationId, (m) => {
      const p = phaseOf(m, key);
      p.clusters = (p.clusters ?? []).map((c) =>
        c.clusterId === clusterId ? { ...c, ...patch } : c,
      );
    });
  }

  markComponent(
    operationId: string,
    key: string,
    status: PlatformUpgradeMetadata['components'][number]['status'],
  ): Promise<void> {
    return this.mutate(operationId, (m) => {
      m.components = m.components.map((c) =>
        c.key === key ? { ...c, status } : c,
      );
    });
  }
}
