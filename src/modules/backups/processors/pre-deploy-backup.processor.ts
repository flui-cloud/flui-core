import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { BACKUP_JOB_TYPES, BACKUP_QUEUE } from '../backups.constants';
import {
  PreDeployBackupResult,
  PreDeployBackupService,
} from '../services/pre-deploy-backup.service';

/**
 * The deploy waits on this job, so it returns as soon as the restore point is
 * recorded and the copies are queued — never after the copies themselves.
 */
@Processor(BACKUP_QUEUE)
export class PreDeployBackupProcessor {
  constructor(private readonly preDeploy: PreDeployBackupService) {}

  @Process(BACKUP_JOB_TYPES.PRE_DEPLOY_BACKUP)
  handle(
    job: Job<{ applicationId: string; deployId: string }>,
  ): Promise<PreDeployBackupResult> {
    return this.preDeploy.run({
      applicationId: job.data.applicationId,
      deployId: job.data.deployId,
    });
  }
}
