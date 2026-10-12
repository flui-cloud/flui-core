import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { AppMigrationEntity } from '../entities/app-migration.entity';
import { AppMigrationStatus } from '../enums/app-migration.enum';

/** The migration row and its operation record, kept in step. */
export class AppMigrationRecord {
  constructor(
    private readonly migRepo: Repository<AppMigrationEntity>,
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    private readonly logger: Logger,
  ) {}

  async isAborted(migrationId: string): Promise<boolean> {
    const fresh = await this.migRepo.findOne({ where: { id: migrationId } });
    return fresh?.status === AppMigrationStatus.ABORTED;
  }

  async setState(
    mig: AppMigrationEntity,
    status: AppMigrationStatus,
    step: OperationStep,
    progress: number,
  ): Promise<void> {
    mig.status = status;
    await this.migRepo.save(mig);
    if (mig.infrastructureOperationId) {
      await this.opRepo.update(mig.infrastructureOperationId, {
        status: OperationStatus.IN_PROGRESS,
        currentStep: step,
        progress,
      });
    }
  }

  async completeOperation(mig: AppMigrationEntity): Promise<void> {
    if (!mig.infrastructureOperationId) return;
    await this.opRepo.update(mig.infrastructureOperationId, {
      status: OperationStatus.COMPLETED,
      completedAt: new Date(),
      progress: 100,
    });
  }

  async fail(mig: AppMigrationEntity, err: any): Promise<void> {
    this.logger.error(`[app-migration] ${mig.id} failed: ${err?.message}`);
    mig.status = AppMigrationStatus.FAILED;
    mig.errorMessage = err?.message ?? String(err);
    mig.finishedAt = new Date();
    await this.migRepo.save(mig);
    if (mig.infrastructureOperationId) {
      await this.opRepo.update(mig.infrastructureOperationId, {
        status: OperationStatus.FAILED,
        errorMessage: mig.errorMessage,
        completedAt: new Date(),
      });
    }
  }
}
