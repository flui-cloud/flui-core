import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';

/** Artifacts whose objects were deleted once an encrypted copy replaced them. */
const NOT_RETIRED = `a.metadata->>'plaintextRetiredAt' IS NULL`;

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

  /** Every artifact of one job: a platform backup writes two, the dump and its key bundle. */
  listByJob(backupJobId: string): Promise<BackupArtifactEntity[]> {
    return this.artifactRepo.find({
      where: { backupJobId },
      relations: ['locations'],
    });
  }

  /** Every artifact of several jobs at once, locations included. */
  listByJobs(backupJobIds: string[]): Promise<BackupArtifactEntity[]> {
    if (backupJobIds.length === 0) return Promise.resolve([]);
    return this.artifactRepo.find({
      where: { backupJobId: In(backupJobIds) },
      relations: ['locations'],
    });
  }

  /** The job of the newest platform backup that produced its key bundle. */
  async latestPlatformJobId(): Promise<string | null> {
    const newest = await this.artifactRepo.findOne({
      where: { engineRef: 'platform:keys' },
      order: { createdAt: 'DESC' },
    });
    return newest?.backupJobId ?? null;
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
      .andWhere(NOT_RETIRED)
      .orderBy('a.createdAt', 'DESC')
      .limit(1)
      .getOne();
  }

  /** Every database-class artifact of one application, newest first. */
  listDbArtifactsForApp(appId: string): Promise<BackupArtifactEntity[]> {
    return this.artifactRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.locations', 'l')
      .where('a.engineClass = :engine', { engine: 'database' })
      .andWhere(
        `(a."applicationId"::text = :appId OR a."manifestSummary"->>'applicationId' = :appId)`,
        { appId },
      )
      .orderBy('a.createdAt', 'DESC')
      .getMany();
  }

  updateArtifactMetadata(
    id: string,
    metadata: Record<string, any>,
  ): Promise<unknown> {
    return this.artifactRepo.update(id, { metadata });
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
        .andWhere(NOT_RETIRED)
        .orderBy('a.createdAt', 'DESC')
        .limit(1)
        .getOne()
    );
  }

  /**
   * Newest object-store copy of one volume that is still stored, or null.
   *
   * Object store only, deliberately: a `pvc-clone` is a sibling claim on the
   * cluster the volume lived on, so for a cluster that is gone it names
   * something that went with it. Restoring from one would mean reaching a
   * machine that no longer answers.
   *
   * A kopia snapshot and an rclone archive compete on recency alone, whatever
   * took them — schedule, a person, a deploy. Only copies whose primary
   * location is still there count: kopia's retention expires snapshots every
   * night, and the newest row being one it removed must not hide the one
   * before it.
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
      .andWhere(`a."manifestSummary"->>'sink' IN ('s3-archive', 'kopia')`)
      .andWhere('(a."expiresAt" IS NULL OR a."expiresAt" > now())')
      .andWhere(NOT_RETIRED)
      .andWhere(
        `EXISTS (SELECT 1 FROM backup_artifact_locations p WHERE p."artifactId" = a.id ` +
          `AND p.role = 'primary' AND p.state IN ('available', 'verified'))`,
      )
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
