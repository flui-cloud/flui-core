import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { BACKUP_JOB_TYPES, BACKUP_QUEUE } from '../backups.constants';
import {
  QueuedBackup,
  VolumeBackupsService,
} from '../../applications/services/volume-backups.service';

/**
 * A backup a person asked for, run from the queue. Here rather than beside the
 * service because every handler of the backup queue lives in one module: a
 * second consumer of the same queue would take jobs it has no handler for.
 */
@Processor(BACKUP_QUEUE)
export class AppVolumeBackupProcessor {
  constructor(private readonly volumeBackups: VolumeBackupsService) {}

  @Process({ name: BACKUP_JOB_TYPES.APP_VOLUME_BACKUP, concurrency: 2 })
  handle(job: Job<QueuedBackup>): Promise<void> {
    return this.volumeBackups.runQueued(job.data);
  }
}
