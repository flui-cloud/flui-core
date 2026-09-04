import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { CreateBackupPolicyDto } from '../dto/create-backup-policy.dto';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupPolicyDestinationEntity } from '../entities/backup-policy-destination.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import {
  BackupPolicyStatus,
  BackupPolicyProfile,
} from '../enums/backup-policy-status.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupScope } from '../enums/backup-scope.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { DestinationPlacementValidator } from './destination-placement.validator';
import { PgBackrestService } from './pgbackrest.service';
import { ContinuousBackupEngineRegistry } from './continuous-backup-engine.registry';

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

    const engine = this.engines.forEngine(declaredEngine);
    await engine.enable(appId, destination, {
      retentionFull: dto.retentionMaxCopies ?? 2,
    });

    try {
      return await this.create(userId, {
        ...dto,
        engine: engine.engine,
      } as CreateBackupPolicyDto & { engine: string });
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

  async create(
    userId: string,
    dto: CreateBackupPolicyDto,
  ): Promise<BackupPolicyEntity> {
    const primaries = dto.destinations.filter(
      (d) => d.role === DestinationRole.PRIMARY,
    );
    if (primaries.length !== 1) {
      throw new BadRequestException(
        'Exactly one PRIMARY destination is required',
      );
    }

    const engineClass = dto.engineClass ?? BackupEngineClass.VOLUME;
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
        primaries[0].destinationId,
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
        primaries[0].destinationId,
      );
    }

    if (engineClass === BackupEngineClass.VOLUME) {
      // The Velero engine only ever narrows by namespace: `applications` and
      // `label_selector` are never translated into the Backup CR, so a policy
      // asking for either quietly captured the whole cluster — more data, more
      // cost, and a scope line that lied. Refuse them rather than keep the lie:
      // per-application protection is what the database and volume-copy
      // classes are for.
      if (
        dto.scope === BackupScope.APPLICATIONS ||
        dto.scope === BackupScope.LABEL_SELECTOR
      ) {
        throw new BadRequestException(
          `A cluster-class policy cannot narrow by ${dto.scope}: the Velero engine ` +
            'only selects namespaces, so this would silently back up the entire ' +
            'cluster. Use scope=namespaces, or protect a single application with a ' +
            'database-class policy (Postgres) or a volume copy.',
        );
      }
    }

    const policy = this.repo.create({
      userId,
      clusterId: dto.clusterId,
      name: dto.name,
      scope: dto.scope,
      engineClass,
      scopeSelector: dto.scopeSelector ?? {},
      includePvcs: dto.includePvcs ?? true,
      includeEtcdL1: dto.includeEtcdL1 ?? false,
      engine: (dto as { engine?: string }).engine,
      cronSchedule: dto.cronSchedule,
      retentionDays: dto.retentionDays ?? 30,
      retentionMaxCopies: dto.retentionMaxCopies,
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
    await this.findById(id);
    await this.repo.update(id, {
      enabled: true,
      status: BackupPolicyStatus.ACTIVE,
    });
    this.logger.log(`[backup-policies] resumed ${id}`);
    return this.findById(id);
  }

  /**
   * Set the operator's age recipient (and optional dead-man's-switch URL) on a
   * platform-class policy. The recipient is public; the private identity never
   * touches the master. Without a recipient the platform backup refuses to run.
   */
  async setPlatformConfig(
    id: string,
    cfg: { recipient: string; heartbeatUrl?: string },
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
    const platform = {
      ...prevPlatform,
      recipient: cfg.recipient,
      heartbeat: cfg.heartbeatUrl
        ? { url: cfg.heartbeatUrl }
        : prevPlatform.heartbeat,
    };
    await this.repo.update(id, {
      metadata: { ...(policy.metadata ?? {}), platform },
    });
    this.logger.log(
      `[backup-policies] platform config set on ${id} (recipient=${cfg.recipient.slice(0, 12)}…, heartbeat=${cfg.heartbeatUrl ? 'set' : 'unchanged'})`,
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

  private inferProfile(n: number): BackupPolicyProfile {
    if (n <= 1) return BackupPolicyProfile.SINGLE;
    if (n === 2) return BackupPolicyProfile.MIRRORED;
    return BackupPolicyProfile.CUSTOM;
  }
}
