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
import {
  BackupPolicyStatus,
  BackupPolicyProfile,
} from '../enums/backup-policy-status.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { DestinationPlacementValidator } from './destination-placement.validator';
import { PgBackrestService } from './pgbackrest.service';

@Injectable()
export class BackupPoliciesService {
  private readonly logger = new Logger(BackupPoliciesService.name);

  constructor(
    private readonly repo: BackupPolicyRepository,
    private readonly placement: DestinationPlacementValidator,
    private readonly pgbackrest: PgBackrestService,
  ) {}

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

    const policy = this.repo.create({
      userId,
      clusterId: dto.clusterId,
      name: dto.name,
      scope: dto.scope,
      engineClass,
      scopeSelector: dto.scopeSelector ?? {},
      includePvcs: dto.includePvcs ?? true,
      includeEtcdL1: dto.includeEtcdL1 ?? false,
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
          await this.pgbackrest.disable(appId);
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
