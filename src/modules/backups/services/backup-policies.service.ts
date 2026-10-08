import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import {
  BackupPolicyOptionsDto,
  CreateBackupPolicyDto,
} from '../dto/create-backup-policy.dto';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupPolicyDestinationEntity } from '../entities/backup-policy-destination.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import {
  BackupPolicyStatus,
  BackupPolicyProfile,
} from '../enums/backup-policy-status.enum';
import {
  BackupEngineClass,
  ENGINE_REMOVED_REASON,
  isRetiredEngineClass,
} from '../enums/backup-engine-class.enum';
import { BackupScope } from '../enums/backup-scope.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { DestinationPlacementValidator } from './destination-placement.validator';
import { PgBackrestService } from './pgbackrest.service';
import { ContinuousBackupEngineRegistry } from './continuous-backup-engine.registry';
import {
  DEFAULT_FULL_EVERY_DAYS,
  defaultBackupSchedule,
} from '../utils/default-schedule.util';

@Injectable()
export class BackupPoliciesService {
  private readonly logger = new Logger(BackupPoliciesService.name);

  constructor(
    private readonly repo: BackupPolicyRepository,
    private readonly placement: DestinationPlacementValidator,
    private readonly pgbackrest: PgBackrestService,
    private readonly engines: ContinuousBackupEngineRegistry,
  ) {}

  /**
   * Turns continuous backup on for one Postgres database, engine first.
   *
   * The order is the point. `pgbackrest.enable` writes the config, creates the
   * stanza and flips `archive_command` — and in doing so validates the whole
   * chain at once: the binary, the maintenance user, a Postgres accepting
   * connections, and S3 credentials that actually reach the bucket. Checking a
   * proxy for any of that and then saving a policy means the first failure
   * arrives on a schedule, hours later, as a failed job nobody is watching.
   * Here it arrives now, as the reason the command did not succeed.
   *
   * If the row cannot then be written, the engine is turned back off. A
   * database left shipping WAL to a repository no policy manages keeps
   * retaining WAL until its own volume fills — an outage of the source.
   */
  async enableDatabase(
    userId: string,
    dto: CreateBackupPolicyDto,
    destination: BackupDestinationEntity,
    /**
     * The engine the catalog declared for this application. Resolved by the
     * caller because it comes from the workload, and persisted below because a
     * disaster restore cannot go back and ask the workload.
     */
    declaredEngine?: string,
  ): Promise<BackupPolicyEntity> {
    const appId = dto.scopeSelector?.applicationIds?.[0];
    if (!appId) {
      throw new BadRequestException(
        'A database policy targets exactly one application',
      );
    }

    // One config file, one `repo1`: a second policy on the same database would
    // overwrite the first's configuration on every run, and the two would take
    // turns shipping WAL to different places.
    const existing = await this.repo.findDbPolicyForApp(appId);
    if (existing) {
      throw new BadRequestException(
        `This database already has continuous backup (policy ${existing.id}). ` +
          'Change where it goes by deleting that policy and enabling again — ' +
          'a database can only ship its WAL to one place.',
      );
    }

    const engine = await this.engines.chooseFor(declaredEngine, appId);
    // Minted before anything is written, and carried on the policy: it names
    // the life of the data directory this protection covers. An engine whose
    // log names restart on a fresh volume would otherwise write, into the
    // prefix its previous life used, file names the repository already holds.
    const generation = engine.mintGeneration?.();
    await engine.enable(appId, destination, {
      retentionFull: dto.retentionMaxCopies ?? 2,
      generation,
    });

    try {
      return await this.create(
        userId,
        {
          ...dto,
          engine: engine.engine,
        } as CreateBackupPolicyDto & { engine: string },
        generation ? { generation } : undefined,
      );
    } catch (err) {
      await engine.disable(appId).catch((cleanupErr: any) => {
        this.logger.error(
          `[backup-policies] enable rolled back for app=${appId} but WAL shipping ` +
            `could not be turned off — the database will retain WAL: ${cleanupErr?.message}`,
        );
      });
      throw err;
    }
  }

  private async assertPlacement(
    dto: CreateBackupPolicyDto,
    engineClass: BackupEngineClass,
    primaryDestinationId: string,
  ): Promise<void> {
    if (engineClass === BackupEngineClass.DATABASE) {
      const appIds = dto.scopeSelector?.applicationIds ?? [];
      if (appIds.length !== 1) {
        throw new BadRequestException(
          'A database-class policy targets exactly one application (scopeSelector.applicationIds must have one id)',
        );
      }
      if (dto.destinations.length > 1) {
        // Replicas would be silently ignored by the db engine — reject rather
        // than let the user believe the backup is mirrored.
        throw new BadRequestException(
          'Database-class policies currently support only the single PRIMARY destination',
        );
      }
      await this.placement.assertOffProvider(
        dto.clusterId,
        primaryDestinationId,
      );
    }

    if (engineClass === BackupEngineClass.VOLUME_COPY) {
      const appIds = dto.scopeSelector?.applicationIds ?? [];
      if (appIds.length !== 1) {
        throw new BadRequestException(
          'A volume-copy policy targets exactly one application ' +
            '(scopeSelector.applicationIds must have one id)',
        );
      }
      // Off the cluster or it is not a backup: an in-cluster clone lives on the
      // application's own disk and is deleted with the application, so a
      // schedule of them costs storage nightly and survives nothing.
      await this.placement.assertOffProvider(
        dto.clusterId,
        primaryDestinationId,
      );
    }
  }

  async create(
    userId: string,
    dto: CreateBackupPolicyDto,
    /** Flui's own facts about the policy, never taken from the request. */
    internal?: Record<string, unknown>,
  ): Promise<BackupPolicyEntity> {
    const primaries = dto.destinations.filter(
      (d) => d.role === DestinationRole.PRIMARY,
    );
    if (primaries.length !== 1) {
      throw new BadRequestException(
        'Exactly one PRIMARY destination is required',
      );
    }

    const engineClass = dto.engineClass ?? this.defaultEngineClass(dto);
    await this.assertPlacement(dto, engineClass, primaries[0].destinationId);

    const engine = (dto as { engine?: string }).engine;
    const pointInTime =
      engineClass !== BackupEngineClass.DATABASE || this.isPointInTime(engine);
    const continuousDatabase =
      engineClass === BackupEngineClass.DATABASE && pointInTime;

    const policy = this.repo.create({
      userId,
      clusterId: dto.clusterId,
      name: dto.name,
      scope: dto.scope,
      engineClass,
      scopeSelector: dto.scopeSelector ?? {},
      includePvcs: dto.includePvcs ?? true,
      includeEtcdL1: dto.includeEtcdL1 ?? false,
      engine,
      cronSchedule:
        dto.cronSchedule ?? defaultBackupSchedule(engineClass, pointInTime),
      retentionDays: dto.retentionDays ?? 30,
      retentionMaxCopies: dto.retentionMaxCopies,
      // Only the options a person may set, then Flui's own: a request that
      // named `generation` would otherwise choose where a database's history
      // is written.
      metadata: {
        ...(dto.metadata?.excludeVolumes?.length
          ? { excludeVolumes: dto.metadata.excludeVolumes }
          : {}),
        ...(dto.metadata?.pauseDuringCopy === true
          ? { pauseDuringCopy: true }
          : {}),
        ...(dto.metadata?.keepMonthly === true ? { keepMonthly: true } : {}),
        ...(continuousDatabase && dto.metadata?.archiveTimeoutSeconds
          ? { archiveTimeoutSeconds: dto.metadata.archiveTimeoutSeconds }
          : {}),
        ...(continuousDatabase
          ? { fullEveryDays: DEFAULT_FULL_EVERY_DAYS }
          : {}),
        ...internal,
      },
      enabled: true,
      status: BackupPolicyStatus.ACTIVE,
      profile: dto.profile ?? this.inferProfile(dto.destinations.length),
    });

    const saved = await this.repo.save(policy);

    const destRows: BackupPolicyDestinationEntity[] = dto.destinations.map(
      (d) =>
        ({
          policyId: saved.id,
          destinationId: d.destinationId,
          role: d.role,
          priority: d.priority ?? 0,
          retentionDaysOverride: d.retentionDaysOverride,
          retentionMaxCopiesOverride: d.retentionMaxCopiesOverride,
          enabled: true,
        }) as BackupPolicyDestinationEntity,
    );
    await this.repo.saveDestinations(destRows);
    return this.findById(saved.id);
  }

  async findById(id: string): Promise<BackupPolicyEntity> {
    const policy = await this.repo.findById(id);
    if (!policy) throw new NotFoundException(`BackupPolicy ${id} not found`);
    return policy;
  }

  async list(userId: string): Promise<BackupPolicyEntity[]> {
    return this.repo.findByUser(userId);
  }

  async listByCluster(clusterId: string): Promise<BackupPolicyEntity[]> {
    return this.repo.findByCluster(clusterId);
  }

  async setStatus(id: string, status: BackupPolicyStatus): Promise<void> {
    await this.repo.update(id, { status });
  }

  /**
   * Gate the schedule off (the scheduler enqueues only on
   * `enabled=true AND status=ACTIVE`). A DATABASE-class policy keeps shipping
   * WAL — deleting it is the only way to stop continuous archiving, since
   * pausing that would tear a hole in the recovery window.
   */
  async pause(id: string): Promise<BackupPolicyEntity> {
    await this.findById(id);
    await this.repo.update(id, {
      enabled: false,
      status: BackupPolicyStatus.PAUSED,
    });
    this.logger.log(`[backup-policies] paused ${id}`);
    return this.findById(id);
  }

  async resume(id: string): Promise<BackupPolicyEntity> {
    const policy = await this.findById(id);
    if (
      isRetiredEngineClass(policy.engineClass) ||
      policy.metadata?.pausedReason === ENGINE_REMOVED_REASON
    ) {
      throw new BadRequestException(
        'This policy used the cluster backup engine Flui no longer has, so it cannot run again. ' +
          'Protect the cluster instead: every application then gets a policy of its own.',
      );
    }
    await this.repo.update(id, {
      enabled: true,
      status: BackupPolicyStatus.ACTIVE,
    });
    this.logger.log(`[backup-policies] resumed ${id}`);
    return this.findById(id);
  }

  /**
   * The decisions a person takes on a volume-copy policy after it exists:
   * stop the application for each copy, or leave volumes out. This is how a
   * volume the last run refused stops needing a decision.
   */
  async updateOptions(
    id: string,
    options: BackupPolicyOptionsDto,
  ): Promise<BackupPolicyEntity> {
    const policy = await this.findById(id);
    if (policy.engineClass !== BackupEngineClass.VOLUME_COPY) {
      throw new BadRequestException(
        'Only a volume-copy policy has options to change here.',
      );
    }
    const metadata: Record<string, any> = { ...policy.metadata };
    if (options.pauseDuringCopy !== undefined) {
      if (options.pauseDuringCopy) metadata.pauseDuringCopy = true;
      else delete metadata.pauseDuringCopy;
    }
    if (options.excludeVolumes !== undefined) {
      if (options.excludeVolumes.length) {
        metadata.excludeVolumes = [...new Set(options.excludeVolumes)];
      } else delete metadata.excludeVolumes;
    }
    if (options.keepMonthly !== undefined) {
      if (options.keepMonthly) metadata.keepMonthly = true;
      else delete metadata.keepMonthly;
    }
    await this.repo.update(id, { metadata });
    this.logger.log(`[backup-policies] options changed on ${id}`);
    return this.findById(id);
  }

  /**
   * Set the operator's age recipient (and optional dead-man's-switch URL) on a
   * platform-class policy. The recipient is public; the private identity never
   * touches the master. Without a recipient the platform backup refuses to run.
   */
  async setPlatformConfig(
    id: string,
    cfg: { recipient: string; heartbeatUrl?: string; clearHeartbeat?: boolean },
  ): Promise<BackupPolicyEntity> {
    const policy = await this.findById(id);
    if (policy.engineClass !== BackupEngineClass.PLATFORM) {
      throw new BadRequestException(
        'Platform config can only be set on a platform-class backup policy.',
      );
    }
    if (!cfg.recipient?.startsWith('age1')) {
      throw new BadRequestException(
        'recipient must be a valid age recipient (age1…).',
      );
    }
    const prevPlatform = policy.metadata?.platform ?? {};
    let heartbeat = prevPlatform.heartbeat;
    if (cfg.heartbeatUrl) heartbeat = { url: cfg.heartbeatUrl };
    else if (cfg.clearHeartbeat) heartbeat = undefined;
    let heartbeatChange = 'unchanged';
    if (cfg.heartbeatUrl) heartbeatChange = 'set';
    else if (cfg.clearHeartbeat) heartbeatChange = 'cleared';
    const platform = {
      ...prevPlatform,
      recipient: cfg.recipient,
      heartbeat,
    };
    await this.repo.update(id, {
      metadata: { ...policy.metadata, platform },
    });
    this.logger.log(
      `[backup-policies] platform config set on ${id} (recipient=${cfg.recipient.slice(0, 12)}…, heartbeat=${heartbeatChange})`,
    );
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    // A database policy leaves archive_command shipping WAL; stop it or the
    // pushes start failing once the destination goes away and the source's
    // volume fills with retained WAL. Best-effort: the pod may already be gone.
    const policy = await this.repo.findById(id);
    if (policy?.engineClass === BackupEngineClass.DATABASE) {
      const appId = policy.scopeSelector?.applicationIds?.[0];
      if (appId) {
        try {
          await this.engines.forEngine(policy.engine).disable(appId);
        } catch (err: any) {
          this.logger.warn(
            `[backup-policies] delete ${id}: could not disable WAL shipping on app=${appId}: ${err?.message}`,
          );
        }
      }
    }
    await this.repo.delete(id);
  }

  primaryDestinationOf(
    policy: BackupPolicyEntity,
  ): BackupPolicyDestinationEntity {
    const p = policy.destinations.find(
      (d) => d.role === DestinationRole.PRIMARY,
    );
    if (!p) throw new Error(`Policy ${policy.id} has no PRIMARY destination`);
    return p;
  }

  replicaDestinationsOf(
    policy: BackupPolicyEntity,
  ): BackupPolicyDestinationEntity[] {
    return policy.destinations
      .filter((d) => d.role === DestinationRole.REPLICA && d.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * A policy that names one application and no engine copies that
   * application's volumes. Anything wider has to say what it is.
   */
  private defaultEngineClass(dto: CreateBackupPolicyDto): BackupEngineClass {
    if (
      dto.scope === BackupScope.APPLICATIONS &&
      (dto.scopeSelector?.applicationIds?.length ?? 0) === 1
    ) {
      return BackupEngineClass.VOLUME_COPY;
    }
    throw new BadRequestException(
      'Say what this policy protects with engineClass: database or volume_copy for one application. ' +
        'To protect every application on a cluster, protect the cluster instead.',
    );
  }

  private isPointInTime(engine: string | undefined): boolean {
    if (!this.engines.supports(engine)) return true;
    return this.engines.forEngine(engine).pointInTime !== false;
  }

  private inferProfile(n: number): BackupPolicyProfile {
    if (n <= 1) return BackupPolicyProfile.SINGLE;
    if (n === 2) return BackupPolicyProfile.MIRRORED;
    return BackupPolicyProfile.CUSTOM;
  }
}
