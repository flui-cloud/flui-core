import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  AppBackupDecision,
  BackupDecisionInput,
  DecidingUser,
  backupDecisionFrom,
} from '../utils/app-backup-decision.rules';
import { ClusterProtectionService } from './cluster-protection.service';

export interface BackupDecisionView {
  applicationId: string;
  decision: AppBackupDecision | null;
}

/**
 * A person's decision that an application is not backed up. It changes what
 * Flui asks for, never what exists: backups already taken stay, and so do the
 * policies naming the application.
 */
@Injectable()
export class AppBackupDecisionService {
  private readonly logger = new Logger(AppBackupDecisionService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    private readonly protection: ClusterProtectionService,
  ) {}

  async set(
    applicationId: string,
    input: BackupDecisionInput,
    user: DecidingUser,
  ): Promise<BackupDecisionView> {
    const app = await this.apps.findOne({
      where: { id: applicationId, deletedAt: IsNull() },
    });
    if (!app) {
      throw new NotFoundException(`Application ${applicationId} not found`);
    }
    const decision = backupDecisionFrom(input, user, new Date());
    await this.apps.update(app.id, { backupDecision: decision as never });
    this.replan(app, !decision);
    return { applicationId: app.id, decision };
  }

  /** The protected cluster's next word on this application, now rather than at the next sweep. */
  private replan(app: ApplicationEntity, backAgain: boolean): void {
    this.protection
      .reconcile(app.clusterId, {
        onlyAppIds: [app.id],
        runFirstBackup: backAgain,
      })
      .catch((err: Error) =>
        this.logger.warn(
          `[backup-decision] ${app.slug}: cluster protection not updated now (${err.message}); the next sweep will`,
        ),
      );
  }
}
