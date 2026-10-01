import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { BACKUP_JOB_TYPES, BACKUP_QUEUE } from '../backups.constants';
import { kopiaRepositoryPrefix } from '../utils/destination-layout.util';

/** A replication of one application's whole kopia repository, not of one backup. */
export interface KopiaReplicationJobData {
  mode: 'kopia-repository';
  applicationId: string;
  backupJobId: string;
  sourceDestinationId: string;
  targetDestinationId: string;
  /** The rows of this run, whose replica copies this sync makes available. */
  locationIds: string[];
}

interface ReplicatedPolicy {
  id: string;
  destinations?: Array<{
    destinationId: string;
    role: string;
    enabled?: boolean;
    priority?: number;
  }>;
}

/**
 * After a volume copy, the application's repository is mirrored to each
 * replica destination: kopia's content is shared between snapshots, so the
 * snapshot of one run is only readable together with everything it points at.
 *
 * The replica is a byte copy, so it opens with the key of the repository it
 * came from — the one derived from the primary destination's passphrase.
 */
@Injectable()
export class KopiaReplicationService {
  private readonly logger = new Logger(KopiaReplicationService.name);

  constructor(
    private readonly artifacts: BackupArtifactRepository,
    @InjectQueue(BACKUP_QUEUE) private readonly queue: Queue,
  ) {}

  async afterRun(args: {
    policy: ReplicatedPolicy;
    applicationId: string;
    backupJobId: string;
    primaryDestinationId: string;
  }): Promise<number> {
    const replicas = (args.policy.destinations ?? [])
      .filter(
        (d) =>
          d.role === DestinationRole.REPLICA &&
          d.enabled !== false &&
          d.destinationId !== args.primaryDestinationId,
      )
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    if (replicas.length === 0) return 0;

    const produced = await this.artifacts.listByJob(args.backupJobId);
    if (produced.length === 0) return 0;

    for (const replica of replicas) {
      const locations = await this.artifacts.saveLocations(
        produced.map(
          (a) =>
            ({
              artifactId: a.id,
              destinationId: replica.destinationId,
              role: DestinationRole.REPLICA,
              state: ArtifactLocationState.PENDING,
              objectKeyPrefix: kopiaRepositoryPrefix(args.applicationId),
            }) as BackupArtifactLocationEntity,
        ),
      );
      const data: KopiaReplicationJobData = {
        mode: 'kopia-repository',
        applicationId: args.applicationId,
        backupJobId: args.backupJobId,
        sourceDestinationId: args.primaryDestinationId,
        targetDestinationId: replica.destinationId,
        locationIds: locations.map((l) => l.id),
      };
      await this.queue.add(BACKUP_JOB_TYPES.REPLICATE_BACKUP, data, {
        attempts: 1,
        removeOnComplete: true,
      });
    }
    this.logger.log(
      `[replicate] app=${args.applicationId} job=${args.backupJobId}: repository sync queued to ${replicas.length} replica(s)`,
    );
    return replicas.length;
  }
}
