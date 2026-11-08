import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupPoliciesService } from './backup-policies.service';
import { BackupJobsService } from './backup-jobs.service';
import { BackupJobTriggerType } from '../enums/backup-job.enum';
import { PgBackrestHaService } from './pgbackrest-ha.service';

/** Rows written before the engine column existed are pgBackRest's, like the registry reads them. */
const SINGLE_INSTANCE_ENGINE = 'postgres';

/**
 * Moves a database's continuous backup to its highly available cluster once
 * that cluster serves: a repository of its own, a full base right away, and
 * the policy pointing at the new engine. The single instance's repository is
 * kept as it is, and its backups restore as before.
 */
@Injectable()
export class DatabaseHaBackupHandoverService {
  private readonly logger = new Logger(DatabaseHaBackupHandoverService.name);

  constructor(
    private readonly policyRepo: BackupPolicyRepository,
    private readonly destRepo: BackupDestinationRepository,
    private readonly policies: BackupPoliciesService,
    private readonly jobs: BackupJobsService,
    private readonly ha: PgBackrestHaService,
  ) {}

  /** What happened to the backup, in words for the operation; null when the database had none. */
  async handOver(
    appId: string,
    { userId, takeBase = true }: { userId?: string; takeBase?: boolean } = {},
  ): Promise<string | null> {
    const policy = await this.policyRepo.findDbPolicyForApp(appId);
    if (!policy) return null;
    if (policy.engine === this.ha.engine) return null;
    if ((policy.engine ?? SINGLE_INSTANCE_ENGINE) !== SINGLE_INSTANCE_ENGINE) {
      return null;
    }
    const highlyAvailable = await this.ha.requireTooling(appId).then(
      () => true,
      (err) => {
        if (err instanceof BadRequestException) return false;
        throw err;
      },
    );
    if (!highlyAvailable) return null;
    const primary = this.policies.primaryDestinationOf(policy);
    const destination = await this.destRepo.findById(primary.destinationId);
    if (!destination) throw new Error('primary destination not found');
    const generation = this.ha.mintGeneration();
    await this.ha.enable(appId, destination, {
      retentionFull: policy.retentionMaxCopies ?? 2,
      generation,
    });
    await this.policyRepo.update(policy.id, {
      engine: this.ha.engine,
      metadata: { ...policy.metadata, generation },
    });
    this.logger.log(
      `[backup] ${appId}: continuous backup moved to the highly available cluster (${generation})`,
    );
    if (!takeBase)
      return 'Continuous backup now ships from the highly available cluster.';
    await this.jobs.createOnDemand(
      userId ?? policy.userId,
      { policyId: policy.id, metadata: { reason: 'database-ha-handover' } },
      BackupJobTriggerType.SCHEDULED,
    );
    return 'Continuous backup now ships from the highly available cluster; its first full backup is running.';
  }
}
