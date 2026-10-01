import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { BACKUP_JOB_TYPES, BACKUP_QUEUE } from '../backups.constants';
import {
  VeleroUninstallJobData,
  VeleroUninstallService,
} from '../services/velero-uninstall.service';

@Processor(BACKUP_QUEUE)
export class UninstallVeleroProcessor {
  constructor(private readonly uninstall: VeleroUninstallService) {}

  @Process(BACKUP_JOB_TYPES.UNINSTALL_VELERO)
  async handle(job: Job<VeleroUninstallJobData>): Promise<void> {
    await this.uninstall.run(job.data);
  }
}
