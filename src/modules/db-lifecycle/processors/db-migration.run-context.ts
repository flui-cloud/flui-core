import { Logger } from '@nestjs/common';
import { Queue } from 'bull';
import { In, Raw, Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { RestoreJobsService } from '../../backups/services/restore-jobs.service';
import { DbPitrService } from '../../backups/services/db-pitr.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterNodeEntity } from '../../infrastructure/clusters/entities/cluster-node.entity';
import { DbPoolerService } from '../../catalog/services/db-pooler.service';
import {
  DbFenceRecord,
  DbMigrationEntity,
} from '../entities/db-migration.entity';
import { DbMigrationStatus } from '../enums/db-migration.enum';
import { DbReplicationService } from '../services/db-replication.service';
import { DbPhysicalReplicationService } from '../services/db-physical-replication.service';
import { DbWriteFenceService } from '../services/db-write-fence.service';
import { DbPodPlacementService } from '../services/db-pod-placement.service';
import { DbPodExecService } from '../services/db-pod-exec.service';
import { DbCredentialHandoffService } from '../services/db-credential-handoff.service';
import { DbPoolerCutService } from '../services/db-pooler-cut.service';

/** The operator aborted while this run was waiting: stop without failing. */
export class MigrationAbortedError extends Error {}

export interface DbMigrationRunContext {
  migRepo: Repository<DbMigrationEntity>;
  opRepo: Repository<InfrastructureOperationEntity>;
  installRepo: Repository<CatalogInstallEntity>;
  userRepo: Repository<UserEntity>;
  appRepo: Repository<ApplicationEntity>;
  nodeRepo: Repository<ClusterNodeEntity>;
  installer: CatalogInstallerService;
  repl: DbReplicationService;
  restoreJobs: RestoreJobsService;
  dbPitr: DbPitrService;
  physical: DbPhysicalReplicationService;
  fence: DbWriteFenceService;
  placement: DbPodPlacementService;
  exec: DbPodExecService;
  handoff: DbCredentialHandoffService;
  queue: Queue;
  poolerCut?: DbPoolerCutService;
  poolers?: DbPoolerService;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
}

/** Row transitions and operation progress shared by every migration path. */
export class DbMigrationState {
  constructor(
    private readonly migRepo: Repository<DbMigrationEntity>,
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    private readonly logger: Logger,
  ) {}

  /**
   * Atomic with abort: promote is asked only while the row is still CUTOVER
   * and nobody has asked before; abort only claims a row nobody promoted.
   */
  async claimPromote(mig: DbMigrationEntity): Promise<boolean> {
    const fence = {
      ...(mig.fence as DbFenceRecord),
      promoteIssuedAt: new Date().toISOString(),
    };
    const res = await this.migRepo.update(
      {
        id: mig.id,
        status: DbMigrationStatus.CUTOVER,
        fence: Raw((col) => `(${col} ->> 'promoteIssuedAt') IS NULL`),
      },
      { fence },
    );
    if (!res.affected) return false;
    mig.fence = fence;
    return true;
  }

  /** A transition the operator's abort can win: losing it stops the run. */
  async enter(
    mig: DbMigrationEntity,
    from: DbMigrationStatus[],
    to: DbMigrationStatus,
  ): Promise<void> {
    if (!(await this.moveFrom(mig, from, to))) {
      throw new MigrationAbortedError();
    }
  }

  async moveFrom(
    mig: DbMigrationEntity,
    from: DbMigrationStatus[],
    to: DbMigrationStatus,
  ): Promise<boolean> {
    const res = await this.migRepo.update(
      { id: mig.id, status: In(from) },
      { status: to, errorMessage: null as unknown as undefined },
    );
    if (!res.affected) return false;
    mig.status = to;
    mig.errorMessage = undefined;
    return true;
  }

  async setStep(
    mig: DbMigrationEntity,
    step: OperationStep,
    progress: number,
  ): Promise<void> {
    if (!mig.infrastructureOperationId) return;
    await this.opRepo.update(mig.infrastructureOperationId, {
      status: OperationStatus.IN_PROGRESS,
      currentStep: step,
      progress,
    });
  }

  async assertNotAborted(mig: DbMigrationEntity): Promise<void> {
    const fresh = await this.migRepo.findOne({ where: { id: mig.id } });
    if (fresh?.status === DbMigrationStatus.ABORTED) {
      throw new MigrationAbortedError();
    }
  }

  async setState(
    mig: DbMigrationEntity,
    status: DbMigrationStatus,
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

  async completeOperation(mig: DbMigrationEntity): Promise<void> {
    if (!mig.infrastructureOperationId) return;
    await this.opRepo.update(mig.infrastructureOperationId, {
      status: OperationStatus.COMPLETED,
      completedAt: new Date(),
      progress: 100,
    });
  }

  async fail(mig: DbMigrationEntity, err: any): Promise<void> {
    this.logger.error(`[db-migration] ${mig.id} failed: ${err?.message}`);
    mig.status = DbMigrationStatus.FAILED;
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
