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

  /** The artifact a completed job produced, if any — a job has at most one. */
  findByJob(backupJobId: string): Promise<BackupArtifactEntity | null> {
    return this.artifactRepo.findOne({
      where: { backupJobId },
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

  /**
   * Every artifact protecting one application, newest first — across engines,
   * so a Postgres app shows its continuous backups and its volume copies in
   * one list.
   */
  listForApplication(applicationId: string): Promise<BackupArtifactEntity[]> {
    return this.artifactRepo.find({
      where: { applicationId },
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

  /**
   * The newest base backup that had finished by a given instant.
   *
   * A point-in-time recovery replays forward from a base, so the base must
   * predate the moment asked for. Handing back the newest one regardless
   * looks right and is not: replaying from a position already past the target
   * applies nothing, and the restore returns state from AFTER the moment it
   * reports — proven against a repository holding two bases.
   */
  findDbArtifactForAppAt(
    appId: string,
    at: Date,
  ): Promise<BackupArtifactEntity | null> {
    return (
      this.artifactRepo
        .createQueryBuilder('a')
        .leftJoinAndSelect('a.locations', 'l')
        .where('a.engineClass = :engine', { engine: 'database' })
        // `::text` on the column, not a bare comparison: the same bound parameter
        // is compared against a uuid column and against a jsonb text extraction
        // in one OR, and Postgres has to give it a single type. Without the cast
        // it infers `text` from the second arm and then finds no `uuid = text`
        // operator — the query fails outright, which is how this arrived as a
        // 500 rather than as an empty result.
        .andWhere(
          `(a."applicationId"::text = :appId OR a."manifestSummary"->>'applicationId' = :appId)`,
          { appId },
        )
        .andWhere('a.createdAt <= :at', { at })
        .orderBy('a.createdAt', 'DESC')
        .limit(1)
        .getOne()
    );
  }

  /**
   * Newest object-store copy of one volume, or null.
   *
   * Object store only, deliberately: a `pvc-clone` is a sibling claim on the
   * cluster the volume lived on, so for a cluster that is gone it names
   * something that went with it. Restoring from one would mean reaching a
   * machine that no longer answers.
   */
  findLatestVolumeCopyForApp(
    applicationId: string,
    volumeName: string,
  ): Promise<BackupArtifactEntity | null> {
    return this.artifactRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.locations', 'l')
      .where('a.engineClass = :engine', { engine: 'volume_copy' })
      .andWhere('a."applicationId" = :applicationId', { applicationId })
      .andWhere('a."volumeName" = :volumeName', { volumeName })
      .andWhere(`a."manifestSummary"->>'sink' = 's3-archive'`)
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
