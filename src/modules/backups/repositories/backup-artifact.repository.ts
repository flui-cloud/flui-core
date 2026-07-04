import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';

@Injectable()
export class BackupArtifactRepository {
  constructor(
    @InjectRepository(BackupArtifactEntity)
    private readonly artifactRepo: Repository<BackupArtifactEntity>,
    @InjectRepository(BackupArtifactLocationEntity)
    private readonly locRepo: Repository<BackupArtifactLocationEntity>,
  ) {}

  createArtifact(data: Partial<BackupArtifactEntity>): BackupArtifactEntity {
    return this.artifactRepo.create(data);
  }

  saveArtifact(entity: BackupArtifactEntity): Promise<BackupArtifactEntity> {
    return this.artifactRepo.save(entity);
  }

  findArtifact(id: string): Promise<BackupArtifactEntity | null> {
    return this.artifactRepo.findOne({
      where: { id },
      relations: ['locations'],
    });
  }

  listForCluster(clusterId: string): Promise<BackupArtifactEntity[]> {
    return this.artifactRepo.find({
      where: { clusterId },
      relations: ['locations'],
      order: { createdAt: 'DESC' },
    });
  }

  /** Newest database-class artifact whose manifest points at the given app. */
  findLatestDbArtifactForApp(
    appId: string,
  ): Promise<BackupArtifactEntity | null> {
    return this.artifactRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.locations', 'l')
      .where('a.engineClass = :engine', { engine: 'database' })
      .andWhere(`a."manifestSummary"->>'applicationId' = :appId`, { appId })
      .orderBy('a.createdAt', 'DESC')
      .limit(1)
      .getOne();
  }

  findLatestWithSizeForCluster(
    clusterId: string,
  ): Promise<BackupArtifactEntity | null> {
    return this.artifactRepo
      .createQueryBuilder('a')
      .where('a.clusterId = :clusterId', { clusterId })
      .andWhere('a.sizeBytes IS NOT NULL')
      .orderBy('a.createdAt', 'DESC')
      .limit(1)
      .getOne();
  }

  saveLocation(
    loc: BackupArtifactLocationEntity,
  ): Promise<BackupArtifactLocationEntity> {
    return this.locRepo.save(loc);
  }

  saveLocations(
    locs: BackupArtifactLocationEntity[],
  ): Promise<BackupArtifactLocationEntity[]> {
    return this.locRepo.save(locs);
  }

  findLocation(
    artifactId: string,
    destinationId: string,
  ): Promise<BackupArtifactLocationEntity | null> {
    return this.locRepo.findOne({ where: { artifactId, destinationId } });
  }

  updateLocation(
    id: string,
    patch: Partial<BackupArtifactLocationEntity>,
  ): Promise<unknown> {
    return this.locRepo.update(id, patch);
  }

  findFailedReplicasReady(): Promise<BackupArtifactLocationEntity[]> {
    return this.locRepo
      .createQueryBuilder('loc')
      .innerJoinAndSelect('loc.destination', 'dest')
      .where('loc.state = :state', { state: 'failed' })
      .andWhere('dest.healthStatus = :health', { health: 'healthy' })
      .getMany();
  }
}
