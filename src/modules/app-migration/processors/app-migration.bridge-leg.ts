import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationMaterializerService } from '../../applications/services/application-materializer.service';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { EndpointBridgeService } from '../../dns/services/endpoint-bridge.service';
import { MigrationBridgeState } from '../../dns/interfaces/migration-bridge.interface';
import { describeError } from '../../shared/utils/error.util';
import { AppMigrationEntity } from '../entities/app-migration.entity';
import { AppMigrationStatus } from '../enums/app-migration.enum';
import { bindToTarget } from '../utils/app-migration-plan.core';
import { AppMigrationRecord } from './app-migration.record';
import { AppMigrationRoutes } from './app-migration.routes';

/** The bridge of a migration: prepared at the end of provisioning, opened at cutover, rolled back before the promote. */
export class AppMigrationBridgeLeg {
  constructor(
    private readonly migRepo: Repository<AppMigrationEntity>,
    private readonly appRepo: Repository<ApplicationEntity>,
    private readonly endpointRepo: Repository<AppEndpointEntity>,
    private readonly materializer: ApplicationMaterializerService,
    private readonly endpointReconciliation: AppEndpointReconciliationService,
    private readonly bridge: EndpointBridgeService,
    private readonly routes: AppMigrationRoutes,
    private readonly record: AppMigrationRecord,
    private readonly logger: Logger,
    private readonly timings: { cutoverCertificateWaitMs: number },
  ) {}

  /**
   * Re-checks the bridge at the end of provisioning and, when it holds,
   * prepares the destination certificate. A bridge that cannot be
   * prepared is not a failed migration: it moves by DNS only and says why.
   */
  async prepare(
    mig: AppMigrationEntity,
    app: ApplicationEntity,
  ): Promise<void> {
    const state = mig.bridgeState;
    if (state?.mode !== 'bridge') return;
    const endpoints = await this.endpointRepo.find({
      where: { applicationId: app.id },
    });
    try {
      const verdict = await this.bridge.preflight({
        endpoints,
        sourceClusterId: mig.srcClusterId,
        targetClusterId: mig.targetClusterId,
        requested: true,
      });
      if (verdict.mode === 'bridge') {
        const hosts = await this.bridge.prepare({
          bridgeId: mig.id,
          endpoints,
          sourceClusterId: mig.srcClusterId,
          targetClusterId: mig.targetClusterId,
        });
        mig.bridgeState = {
          ...state,
          state: 'preparing',
          hosts,
          routePrepared: await this.routes.prepareRoutes(mig, hosts),
          preparedAt: new Date().toISOString(),
        };
      } else {
        mig.bridgeState = { ...state, ...verdict };
      }
    } catch (err: unknown) {
      mig.bridgeState = {
        ...state,
        mode: 'dns-only',
        skipReason: `The bridge could not be prepared: ${describeError(err)}`,
      };
    }
    // Only the bridge column: a whole-row save here would undo an abort that
    // landed while the certificate was being prepared.
    await this.migRepo.update(mig.id, { bridgeState: mig.bridgeState });
  }

  async discardPrepared(mig: AppMigrationEntity): Promise<void> {
    if (mig.bridgeState?.routePrepared) {
      for (const host of mig.bridgeState.hosts) {
        for (const endpointId of host.endpointIds) {
          await this.endpointReconciliation
            .deleteEndpointResources(endpointId, {
              clusterId: mig.targetClusterId,
            })
            .catch(() => undefined);
        }
      }
    }
    if (mig.bridgeState?.hosts?.length) {
      await this.bridge
        .discard(mig.bridgeState.hosts, mig.targetClusterId)
        .catch(() => undefined);
    }
  }

  /**
   * Undoes a bridge opened ahead of the promote, route first: the endpoints
   * and their route go back to the source, which serves again, before the
   * bridge closes and the destination route goes (its certificate stays for a
   * retry). Never once the app moved to the destination.
   */
  async rollback(mig: AppMigrationEntity): Promise<void> {
    const state = mig.bridgeState;
    if (state?.state !== 'active') return;
    const app = await this.appRepo.findOne({ where: { id: mig.srcAppId } });
    if (app?.clusterId === mig.targetClusterId) {
      throw new Error(
        `Application ${mig.srcAppId} is already served from the destination; the bridge stays open`,
      );
    }
    const endpoints = await this.endpointRepo.find({
      where: { applicationId: mig.srcAppId },
    });
    await this.routes.rebindEndpoints(endpoints, mig.srcClusterId, null);
    await this.routes.reconcileRoutes(endpoints);
    const left = await this.bridge.close(state.hosts ?? [], mig.srcClusterId);
    if (left) {
      this.logger.warn(`[app-migration] ${mig.id}: bridge rollback: ${left}`);
    }
    for (const ep of endpoints) {
      await this.endpointReconciliation
        .deleteEndpointResources(ep.id, {
          clusterId: mig.targetClusterId,
          keepCertificate: true,
        })
        .catch((e: unknown) =>
          this.logger.warn(
            `[app-migration] ${mig.id}: destination route of ${ep.fqdn} not removed: ${describeError(e)}`,
          ),
        );
    }
    mig.bridgeState = {
      ...state,
      state: 'preparing',
      routePrepared: false,
      activatedAt: undefined,
      targetAddresses: undefined,
      sourceRouteRemovedAt: undefined,
    };
    // READY so the full migration can retry or abort it; the note says why.
    mig.status = AppMigrationStatus.READY;
    mig.errorMessage =
      'The bridge was rolled back before the promote; the source serves again.';
    await this.migRepo.save(mig);
    this.logger.log(
      `[app-migration] ${mig.id}: bridge rolled back, ${mig.srcClusterId} serves again`,
    );
  }

  /** False when the bridge cannot be opened and the cutover goes on by DNS only. */
  async cutover(
    mig: AppMigrationEntity,
    app: ApplicationEntity,
    endpoints: AppEndpointEntity[],
    volumesMoved: boolean,
    stopAfterBridgeOpen = false,
  ): Promise<boolean> {
    let state = mig.bridgeState as MigrationBridgeState;
    const warnings: string[] = [];
    if (state.state !== 'active') {
      const opened = await this.openWhenCertificatesHold(
        mig,
        app,
        endpoints,
        volumesMoved,
        state,
      );
      if (!opened) return false;
      state = opened;
    }

    // An HTTPS route of the source for the same names takes them from the
    // passthrough router, so the source route goes right after activation.
    // Before the fence its certificate stays, so a rollback does not re-issue it.
    let sourceRouteGone = false;
    if (state.state !== 'active' || !mig.bridgeState?.sourceRouteRemovedAt) {
      await this.routes.removeSourceRoutes(
        mig,
        endpoints,
        stopAfterBridgeOpen,
        warnings,
      );
      sourceRouteGone = !stopAfterBridgeOpen;
      if (state.state !== 'active' && state.routePrepared) {
        // The prepared route already serves; this brings the moved rows in step.
        await this.routes
          .reconcileRoutes(endpoints)
          .catch((e: unknown) =>
            warnings.push(
              `the destination route was not refreshed: ${describeError(e)}`,
            ),
          );
      }
    }

    if (stopAfterBridgeOpen) {
      mig.bridgeState = {
        ...(mig.bridgeState as MigrationBridgeState),
        sourceRouteRemovedAt: new Date().toISOString(),
      };
      mig.errorMessage = warnings.length
        ? `bridge opened with warnings: ${warnings.join('; ')}`
        : undefined;
      await this.migRepo.save(mig);
      this.logger.log(
        `[app-migration] ${mig.id}: ${mig.srcClusterId} forwards to ${mig.targetClusterId}; the app stays bound to the source until the promote`,
      );
      return true;
    }

    bindToTarget(mig, app);
    await this.appRepo.save(app);

    if (!sourceRouteGone) {
      await this.routes.removeSourceRoutes(mig, endpoints, false, warnings);
    }
    await this.materializer.scaleOnCluster(app, mig.srcClusterId, 0);
    await this.materializer.waitStoppedOnCluster(app, mig.srcClusterId);

    const flip = await this.routes.flipDns(endpoints);
    if (flip.problems.length) {
      throw new Error(
        `The bridge is open but DNS did not move: ${flip.problems.join('; ')}`,
      );
    }

    mig.dnsFlippedAt = new Date();
    mig.bridgeState = {
      ...(mig.bridgeState as MigrationBridgeState),
      dnsFlippedAt: mig.dnsFlippedAt.toISOString(),
      recordTtlSeconds: flip.ttl ?? mig.bridgeState?.recordTtlSeconds ?? null,
    };
    mig.status = AppMigrationStatus.BRIDGING;
    mig.errorMessage = warnings.length
      ? `cutover completed with warnings: ${warnings.join('; ')}`
      : undefined;
    await this.migRepo.save(mig);
    await this.record.completeOperation(mig);
    this.logger.log(
      `[app-migration] ${mig.id} BRIDGING: app ${mig.srcAppId} served from ${mig.targetClusterId}; ${mig.srcClusterId} forwards ${endpoints.length} endpoint(s) until the source is destroyed`,
    );
    return true;
  }

  /** The state the bridge opened from, or null when it cannot open and DNS moves alone. */
  private async openWhenCertificatesHold(
    mig: AppMigrationEntity,
    app: ApplicationEntity,
    endpoints: AppEndpointEntity[],
    volumesMoved: boolean,
    initial: MigrationBridgeState,
  ): Promise<MigrationBridgeState | null> {
    let state = initial;
    if (!volumesMoved) {
      await this.materializer.waitReadyOnCluster(app, mig.targetClusterId);
    }
    let problem = await this.bridge.certificatesValid(
      state.hosts ?? [],
      mig.targetClusterId,
    );
    if (problem) {
      const hosts = await this.bridge
        .prepare({
          bridgeId: mig.id,
          endpoints,
          sourceClusterId: mig.srcClusterId,
          targetClusterId: mig.targetClusterId,
          waitMs: this.timings.cutoverCertificateWaitMs,
        })
        .catch(() => null);
      if (hosts) {
        state = { ...state, hosts, routePrepared: false };
        mig.bridgeState = state;
        problem = await this.bridge.certificatesValid(
          hosts,
          mig.targetClusterId,
        );
      }
    }
    if (problem) {
      mig.bridgeState = { ...state, mode: 'dns-only', skipReason: problem };
      await this.migRepo.save(mig);
      this.logger.warn(
        `[app-migration] ${mig.id}: no bridge, DNS moves alone — ${problem}`,
      );
      return null;
    }
    await this.openBridge(mig, app, endpoints, volumesMoved);
    return state;
  }

  /**
   * Everything before the point of no return: the endpoints move to the
   * destination with their DNS held, the destination route is built, then the
   * source starts forwarding. Any failure puts the route back where it was.
   */
  private async openBridge(
    mig: AppMigrationEntity,
    app: ApplicationEntity,
    endpoints: AppEndpointEntity[],
    volumesMoved: boolean,
  ): Promise<void> {
    const state = mig.bridgeState as MigrationBridgeState;
    let activationAttempted = false;
    try {
      await this.routes.rebindEndpoints(endpoints, mig.targetClusterId, mig.id);
      if (!state.routePrepared) await this.routes.reconcileRoutes(endpoints);
      activationAttempted = true;
      const targetAddresses = await this.bridge.activate(
        mig.id,
        state.hosts ?? [],
        mig.srcClusterId,
        mig.targetClusterId,
      );
      mig.bridgeState = {
        ...state,
        state: 'active',
        activatedAt: new Date().toISOString(),
        targetAddresses,
      };
      await this.migRepo.save(mig);
    } catch (err) {
      await this.rollbackBeforeActivation(
        mig,
        app,
        endpoints,
        volumesMoved,
        activationAttempted,
      );
      mig.bridgeState = {
        ...state,
        state: 'preparing',
        routePrepared: false,
        activatedAt: undefined,
        targetAddresses: undefined,
        sourceRouteRemovedAt: undefined,
      };
      throw err;
    }
  }

  private async rollbackBeforeActivation(
    mig: AppMigrationEntity,
    app: ApplicationEntity,
    endpoints: AppEndpointEntity[],
    volumesMoved: boolean,
    activationAttempted: boolean,
  ): Promise<void> {
    const note = (what: string) => (e: unknown) =>
      this.logger.error(
        `[app-migration] ${mig.id}: rollback could not ${what}: ${describeError(e)}`,
      );
    if (activationAttempted) {
      const left = await this.bridge
        .close(mig.bridgeState?.hosts ?? [], mig.srcClusterId)
        .catch((e: unknown) => describeError(e));
      if (left) note('remove the bridge')(left);
    }
    await this.routes
      .rebindEndpoints(endpoints, mig.srcClusterId, null)
      .catch(note('put the endpoints back on the source'));
    for (const ep of endpoints) {
      await this.endpointReconciliation
        .deleteEndpointResources(ep.id, {
          clusterId: mig.targetClusterId,
          keepCertificate: true,
        })
        .catch(note(`remove the destination route of ${ep.fqdn}`));
    }
    if (volumesMoved) {
      await this.materializer
        .scaleOnCluster(app, mig.targetClusterId, 0)
        .catch(note('stop the destination'));
      await this.materializer
        .scaleOnCluster(app, mig.srcClusterId, Math.max(1, app.replicas ?? 1))
        .catch(note('restart the source'));
    }
  }
}
