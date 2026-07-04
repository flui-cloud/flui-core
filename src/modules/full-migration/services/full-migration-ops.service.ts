import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { DbMigrationEntity } from '../../db-lifecycle/entities/db-migration.entity';
import { DbMigrationStatus } from '../../db-lifecycle/enums/db-migration.enum';
import { AppMigrationEntity } from '../../app-migration/entities/app-migration.entity';
import { AppMigrationStatus } from '../../app-migration/enums/app-migration.enum';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import { FullMigrationStatus } from '../enums/full-migration.enum';

const POLL_INTERVAL_MS = 5_000;

/**
 * Progress/state plumbing for the full-migration orchestrator: entity + linked
 * operation updates and the child-leg wait loops. Holds no cutover logic — the
 * processor owns the state machine and calls these.
 */
@Injectable()
export class FullMigrationOpsService {
  private readonly logger = new Logger(FullMigrationOpsService.name);

  constructor(
    @InjectRepository(FullMigrationEntity)
    private readonly fmRepo: Repository<FullMigrationEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    @InjectRepository(DbMigrationEntity)
    private readonly dbMigRepo: Repository<DbMigrationEntity>,
    @InjectRepository(AppMigrationEntity)
    private readonly appMigRepo: Repository<AppMigrationEntity>,
  ) {}

  async load(id: string): Promise<FullMigrationEntity> {
    const fm = await this.fmRepo.findOne({ where: { id } });
    if (!fm) throw new Error(`Full-migration ${id} not found`);
    return fm;
  }

  async waitDb(
    id: string,
    target: DbMigrationStatus,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const child = await this.dbMigRepo.findOne({ where: { id } });
      if (!child) throw new Error(`DB migration ${id} vanished`);
      if (child.status === target) return;
      if (
        child.status === DbMigrationStatus.FAILED ||
        child.status === DbMigrationStatus.ABORTED
      ) {
        throw new Error(
          `DB migration ${id} ended in ${child.status}: ${child.errorMessage ?? 'unknown'}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `DB migration ${id} did not reach ${target} in time (last ${child.status})`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  async waitApp(
    id: string,
    target: AppMigrationStatus,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const child = await this.appMigRepo.findOne({ where: { id } });
      if (!child) throw new Error(`App migration ${id} vanished`);
      if (child.status === target) return;
      if (
        child.status === AppMigrationStatus.FAILED ||
        child.status === AppMigrationStatus.ABORTED
      ) {
        throw new Error(
          `App migration ${id} ended in ${child.status}: ${child.errorMessage ?? 'unknown'}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `App migration ${id} did not reach ${target} in time (last ${child.status})`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  async setState(
    fm: FullMigrationEntity,
    status: FullMigrationStatus,
    step: OperationStep,
    progress: number,
  ): Promise<void> {
    fm.status = status;
    await this.fmRepo.save(fm);
    await this.setStep(fm, step, progress);
  }

  async setStep(
    fm: FullMigrationEntity,
    step: OperationStep,
    progress: number,
  ): Promise<void> {
    if (!fm.infrastructureOperationId) return;
    await this.opRepo.update(fm.infrastructureOperationId, {
      status: OperationStatus.IN_PROGRESS,
      currentStep: step,
      progress,
    });
  }

  async completeOperation(fm: FullMigrationEntity): Promise<void> {
    if (!fm.infrastructureOperationId) return;
    await this.opRepo.update(fm.infrastructureOperationId, {
      status: OperationStatus.COMPLETED,
      completedAt: new Date(),
      progress: 100,
    });
  }

  async fail(
    fm: FullMigrationEntity,
    err: any,
    status: FullMigrationStatus,
  ): Promise<void> {
    this.logger.error(`[full-migration] ${fm.id} ${status}: ${err?.message}`);
    fm.status = status;
    fm.errorMessage = err?.message ?? String(err);
    fm.finishedAt = new Date();
    await this.fmRepo.save(fm);
    if (fm.infrastructureOperationId) {
      await this.opRepo.update(fm.infrastructureOperationId, {
        status: OperationStatus.FAILED,
        errorMessage: fm.errorMessage,
        completedAt: new Date(),
      });
    }
  }
}
