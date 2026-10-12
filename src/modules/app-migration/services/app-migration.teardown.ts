import { ConflictException, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationMaterializerService } from '../../applications/services/application-materializer.service';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { EndpointBridgeService } from '../../dns/services/endpoint-bridge.service';
import { describeError } from '../../shared/utils/error.util';
import { AppMigrationEntity } from '../entities/app-migration.entity';
import { AppMigrationStatus } from '../enums/app-migration.enum';
import { bridgeView } from '../utils/bridge-view';
import { bridgeStillNeeded } from '../utils/app-migration-state.core';

/** What a migration leaves behind on the cluster it does not end on. */
export class AppMigrationTeardown {
  constructor(
    private readonly migRepo: Repository<AppMigrationEntity>,
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    private readonly endpointRepo: Repository<AppEndpointEntity>,
    private readonly materializer: ApplicationMaterializerService,
    private readonly reconciliation: AppEndpointReconciliationService,
    private readonly bridge: EndpointBridgeService,
    private readonly logger: Logger,
  ) {}

  async abort(
    id: string,
    mig: AppMigrationEntity,
    app: ApplicationEntity | null,
  ): Promise<void> {
    await this.releaseDestination(id, mig, app);
    mig.status = AppMigrationStatus.ABORTED;
    mig.finishedAt = new Date();
    await this.migRepo.save(mig);
    if (mig.infrastructureOperationId) {
      await this.opRepo.update(mig.infrastructureOperationId, {
        status: OperationStatus.CANCELLED,
        completedAt: new Date(),
      });
    }
    this.logger.log(`[app-migration] aborted ${id}`);
  }

  private async releaseDestination(
    id: string,
    mig: AppMigrationEntity,
    app: ApplicationEntity | null,
  ): Promise<void> {
    // Only tear down inline when no materialize is in flight; while PROVISIONING
    // the processor re-applies concurrently, so it tears the destination down
    // itself once it observes ABORTED after materialize returns (avoids a
    // delete-vs-apply race). The `clusterId !== target` guard never tears down a
    // destination the app has already been re-bound to (cutover done/underway).
    if (
      mig.status !== AppMigrationStatus.PROVISIONING &&
      app &&
      app.clusterId !== mig.targetClusterId
    ) {
      await this.materializer
        .teardownOnCluster(app, mig.targetClusterId)
        .catch((err: unknown) =>
          this.logger.warn(
            `[app-migration] abort ${id}: destination teardown failed: ${describeError(
              err,
            )}`,
          ),
        );
    }
    if (
      mig.status !== AppMigrationStatus.PROVISIONING &&
      mig.bridgeState?.routePrepared &&
      app
    ) {
      for (const ep of await this.endpointRepo.find({
        where: { applicationId: app.id },
      })) {
        if (ep.clusterId === mig.targetClusterId) continue;
        await this.reconciliation
          .deleteEndpointResources(ep.id, { clusterId: mig.targetClusterId })
          .catch((err: unknown) =>
            this.logger.warn(
              `[app-migration] abort ${id}: route ${ep.fqdn} not removed from the destination: ${describeError(err)}`,
            ),
          );
      }
    }
    if (
      mig.status !== AppMigrationStatus.PROVISIONING &&
      mig.bridgeState?.hosts?.length
    ) {
      await this.bridge
        .discard(mig.bridgeState.hosts, mig.targetClusterId)
        .catch((err: unknown) =>
          this.logger.warn(
            `[app-migration] abort ${id}: bridge certificates not removed: ${describeError(err)}`,
          ),
        );
    }
  }

  async destroySource(
    id: string,
    mig: AppMigrationEntity,
    app: ApplicationEntity,
    bridging: boolean,
    opts: { closeBridge?: boolean },
  ): Promise<void> {
    if (bridging && mig.bridgeState) {
      const view = bridgeView(mig, new Date());
      if (!view?.readyToClose && !opts.closeBridge) {
        throw new ConflictException(bridgeStillNeeded(view));
      }
      const leftover = await this.bridge.close(
        mig.bridgeState.hosts ?? [],
        mig.srcClusterId,
      );
      mig.bridgeState = {
        ...mig.bridgeState,
        state: 'closed',
        closedAt: new Date().toISOString(),
        leftover,
      };
      await this.migRepo.save(mig);
    }

    const endpoints = await this.endpointRepo.find({
      where: { applicationId: app.id },
    });
    for (const endpoint of endpoints) {
      if (endpoint.clusterId === mig.srcClusterId) continue;
      await this.reconciliation
        .deleteEndpointResources(endpoint.id, { clusterId: mig.srcClusterId })
        .catch((err: unknown) =>
          this.logger.warn(
            `[app-migration] ${id}: route ${endpoint.fqdn} not removed from the source: ${describeError(err)}`,
          ),
        );
    }
    await this.materializer.teardownOnCluster(app, mig.srcClusterId);
  }
}
