import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InfrastructureOperationEntity } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationMaterializerService } from '../../applications/services/application-materializer.service';
import { AppMigrationEntity } from '../entities/app-migration.entity';
import {
  AppVolumeTransferService,
  VolumeTransferPlan,
} from '../services/app-volume-transfer.service';
import { describeError } from '../../shared/utils/error.util';

/** The workloads a migration stops, copies and tears down on either cluster. */
export class AppMigrationWorkloads {
  constructor(
    private readonly materializer: ApplicationMaterializerService,
    private readonly volumes: AppVolumeTransferService,
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    private readonly logger: Logger,
  ) {}

  /**
   * The interruption: the source stops so its volumes stop changing, they are
   * copied, and the destination starts on them. Until DNS moves, every failure
   * gives the source back its copies, so the application never stays down
   * because a move did not finish.
   */
  async moveVolumes(
    mig: AppMigrationEntity,
    app: ApplicationEntity,
    plan: VolumeTransferPlan,
  ): Promise<void> {
    const replicas = Math.max(1, app.replicas ?? 1);
    const stoppedAt = Date.now();
    try {
      await this.materializer.scaleOnCluster(app, mig.srcClusterId, 0);
      await this.materializer.waitStoppedOnCluster(app, mig.srcClusterId);
      await this.volumes.copy(app, plan, mig.userId, mig.targetClusterId);
      await this.materializer.scaleOnCluster(
        app,
        mig.targetClusterId,
        replicas,
      );
      await this.materializer.waitReadyOnCluster(app, mig.targetClusterId);
    } catch (err) {
      this.logger.error(
        `[app-migration] ${mig.id}: volumes not moved (${(err as Error).message}) — restarting the source`,
      );
      await this.materializer
        .scaleOnCluster(app, mig.targetClusterId, 0)
        .catch(() => undefined);
      await this.materializer
        .scaleOnCluster(app, mig.srcClusterId, replicas)
        .catch((e: unknown) =>
          this.logger.error(
            `[app-migration] ${mig.id}: the source could not be restarted: ${(e as Error).message}`,
          ),
        );
      throw new Error(
        `The volumes could not be moved, so ${app.slug} is running on its original cluster again: ${(err as Error).message}`,
      );
    }
    mig.interruptionMs = Date.now() - stoppedAt;
    const seconds = Math.round(mig.interruptionMs / 1000);
    this.logger.log(
      `[app-migration] ${mig.id}: ${app.slug} was stopped for ${seconds}s while its volumes moved`,
    );
    if (mig.infrastructureOperationId) {
      const op = await this.opRepo.findOne({
        where: { id: mig.infrastructureOperationId },
      });
      if (op) {
        op.metadata = { ...op.metadata, interruptionSeconds: seconds };
        await this.opRepo.save(op);
      }
    }
  }

  async teardownDestination(
    app: ApplicationEntity,
    mig: AppMigrationEntity,
  ): Promise<void> {
    await this.materializer
      .teardownOnCluster(app, mig.targetClusterId)
      .catch((e: unknown) =>
        this.logger.warn(
          `[app-migration] ${mig.id}: destination teardown failed: ${describeError(
            e,
          )}`,
        ),
      );
  }
}
