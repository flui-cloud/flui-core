import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { FullMigrationService } from '../../full-migration/services/full-migration.service';
import { FullMigrationEntity } from '../../full-migration/entities/full-migration.entity';
import {
  FullCutoverMode,
  FullMigrationStatus,
  FullStagingMode,
} from '../../full-migration/enums/full-migration.enum';
import { DemoConfigEntity } from '../entities/demo-config.entity';
import { DemoLoopState, DemoProvisionMode } from '../enums/demo.enum';
import { DemoStateService } from './demo-state.service';
import { DemoEventsService, DemoEventType } from './demo-events.service';

const PRE_CUTOVER = new Set<FullMigrationStatus>([
  FullMigrationStatus.PENDING,
  FullMigrationStatus.DB_REPLICATING,
  FullMigrationStatus.APP_STAGING,
]);

const MAX_STRIKES = 3;
const CUTOVER_GRACE_MS = 90_000;
/** Public failure phrase; the raw reason stays on the admin config + logs. */
const PUBLIC_FAILURE = 'migration failed; operator notified';

/**
 * The demo loop: on a steady interval it migrates the demo app to the other of
 * two pre-registered workload clusters, drives the cutover itself so it can open
 * an honest disruption window around it, drains the old cluster, tears down the
 * source workload, and returns to idle to await the next cycle.
 */
@Injectable()
export class DemoOrchestratorService {
  private readonly logger = new Logger(DemoOrchestratorService.name);
  private lastEmittedStatus?: string;

  constructor(
    private readonly state: DemoStateService,
    private readonly events: DemoEventsService,
    private readonly fullMig: FullMigrationService,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
  ) {}

  async tick(): Promise<void> {
    const cfg = await this.state.get();
    // When disabled, let an in-flight cycle finish but start no new ones.
    if (!cfg.enabled && cfg.state === DemoLoopState.IDLE) return;

    switch (cfg.state) {
      case DemoLoopState.IDLE:
        return this.maybeStartCycle(cfg);
      case DemoLoopState.MIGRATING:
        return this.advanceMigration(cfg);
      case DemoLoopState.DRAINING:
        return this.advanceDrain(cfg);
      case DemoLoopState.FAILED:
        return; // operator must reset
    }
  }

  async triggerNow(): Promise<void> {
    const cfg = await this.state.get();
    if (cfg.state !== DemoLoopState.IDLE) {
      throw new Error(`Demo is not idle (state=${cfg.state}); cannot trigger.`);
    }
    await this.startCycle(cfg, true);
  }

  /** Recover from FAILED: abort a still-abortable migration, else refuse. */
  async reset(): Promise<DemoConfigEntity> {
    const cfg = await this.state.get();
    if (cfg.activeFullMigrationId) {
      try {
        await this.fullMig.abort(cfg.activeFullMigrationId);
      } catch (err: any) {
        this.logger.warn(
          `[demo] reset could not abort ${cfg.activeFullMigrationId}: ${err?.message ?? err}`,
        );
        return this.state.patch({
          lastError: `reset blocked: active migration is past the point of no return and must be resolved by hand (${err?.message ?? err})`,
        });
      }
    }
    return this.state.patch({
      state: DemoLoopState.IDLE,
      windowOpen: false,
      activeFullMigrationId: null,
      cutoverRequestedAt: null,
      strikes: 0,
      lastError: null,
    });
  }

  private async maybeStartCycle(cfg: DemoConfigEntity): Promise<void> {
    if (!this.isDue(cfg)) return;
    await this.startCycle(cfg, false);
  }

  private isDue(cfg: DemoConfigEntity): boolean {
    if (!cfg.lastCycleAt) return true;
    const elapsed = Date.now() - new Date(cfg.lastCycleAt).getTime();
    return elapsed >= cfg.intervalMinutes * 60_000;
  }

  private async startCycle(
    cfg: DemoConfigEntity,
    forced: boolean,
  ): Promise<void> {
    // Non-retryable pre-checks — a misconfig will never fix itself.
    if (cfg.provisionMode !== DemoProvisionMode.FIXED_PAIR) {
      return this.hardFail(
        `provisionMode=${cfg.provisionMode} is not wired yet; use fixed-pair.`,
        false,
      );
    }
    const cfgErr = this.configError(cfg);
    if (cfgErr) return this.hardFail(cfgErr, false);

    // Atomically claim the loop so a tick and an admin trigger can't both start.
    if (!(await this.state.claimIdle())) return;

    try {
      await this.clearPendingCleanup(); // owe a source teardown? do it first
      const app = await this.appRepo.findOne({ where: { id: cfg.appId } });
      if (!app) throw new Error('demo app lookup returned nothing');

      let target: string;
      try {
        target = this.pickTarget(cfg, app.clusterId);
      } catch (e: any) {
        return this.hardFail(e?.message ?? String(e), false); // misconfig
      }

      const [srcCluster, dstCluster] = await Promise.all([
        this.clusterRepo.findOne({ where: { id: app.clusterId } }),
        this.clusterRepo.findOne({ where: { id: target } }),
      ]);
      if (!dstCluster) throw new Error(`target cluster ${target} not found`);
      if (
        dstCluster.status !== ClusterStatus.READY ||
        dstCluster.clusterType !== ClusterType.WORKLOAD
      ) {
        throw new Error(
          `target cluster ${target} is not a READY workload cluster (status=${dstCluster.status}, type=${dstCluster.clusterType})`,
        );
      }

      const fm = await this.fullMig.create(cfg.ownerUserId, {
        appId: cfg.appId,
        dbAppId: cfg.dbAppId,
        targetClusterId: target,
        cutover: FullCutoverMode.MANUAL,
        stagingMode: cfg.stagingMode as FullStagingMode,
      });

      await this.state.patch({
        activeFullMigrationId: fm.id,
        currentClusterId: app.clusterId,
        windowOpen: false,
        cycleStartedAt: new Date(),
        drainStartedAt: null,
        cutoverRequestedAt: null,
        lastError: null,
        strikes: 0,
      });
      this.lastEmittedStatus = undefined;
      this.events.emit(DemoEventType.CYCLE_STARTED, {
        migrationId: fm.id,
        forced,
        source: { clusterId: app.clusterId, provider: srcCluster?.provider },
        target: { clusterId: target, provider: dstCluster.provider },
        ts: new Date().toISOString(),
      });
      this.logger.log(
        `[demo] cycle started: app ${cfg.appId} ${srcCluster?.provider ?? '?'} → ${dstCluster.provider} (fm ${fm.id})`,
      );
    } catch (err: any) {
      await this.retryStartOrFail(cfg, err?.message ?? String(err));
    }
  }

  private async advanceMigration(cfg: DemoConfigEntity): Promise<void> {
    if (!cfg.activeFullMigrationId) {
      return this.hardFail('MIGRATING with no active migration id', false);
    }
    let fm: FullMigrationEntity;
    try {
      fm = await this.fullMig.findById(cfg.activeFullMigrationId);
    } catch (err: any) {
      // Transient lookup blip — keep driving the live migration, don't abandon it.
      return this.bumpStrikeOrFail(
        cfg,
        `migration lookup failed: ${err?.message ?? err}`,
      );
    }
    this.emitProgress(fm);

    if (PRE_CUTOVER.has(fm.status)) return;

    if (fm.status === FullMigrationStatus.READY) {
      if (!cfg.windowOpen) {
        await this.state.patch({ windowOpen: true });
        this.events.emit(DemoEventType.WINDOW_OPENED, {
          migrationId: fm.id,
          ts: new Date().toISOString(),
        });
      }
      await this.requestCutover(cfg, fm);
      return;
    }

    if (fm.status === FullMigrationStatus.CUTOVER) return; // in progress

    if (fm.status === FullMigrationStatus.FAILED_FORWARD) {
      // DB already promoted — target is the truth. Keep the window open and keep
      // driving the app leg forward; the outage stays attributed to migration.
      await this.state.patch({
        currentClusterId: fm.targetClusterId,
        windowOpen: true,
      });
      if (cfg.strikes < MAX_STRIKES) {
        await this.state.patch({ strikes: cfg.strikes + 1 });
        await this.requestCutover(cfg, fm, true);
        return;
      }
      return this.hardFail(
        `migration ${fm.id} stuck in ${fm.status} after ${MAX_STRIKES} retries: ${fm.errorMessage ?? ''}`,
        true,
        fm.targetClusterId,
      );
    }

    if (fm.status === FullMigrationStatus.COMPLETED) {
      await this.state.patch({
        state: DemoLoopState.DRAINING,
        currentClusterId: fm.targetClusterId,
        drainStartedAt: new Date(),
        cutoverRequestedAt: null,
        strikes: 0,
      });
      this.events.emit(DemoEventType.DRAIN_STARTED, {
        migrationId: fm.id,
        targetClusterId: fm.targetClusterId,
        drainMinutes: cfg.drainMinutes,
        ts: new Date().toISOString(),
      });
      return;
    }

    if (
      fm.status === FullMigrationStatus.FAILED ||
      fm.status === FullMigrationStatus.ABORTED
    ) {
      return this.hardFail(
        `migration ${fm.id} ended ${fm.status}: ${fm.errorMessage ?? ''}`,
        false,
      );
    }

    this.logger.warn(
      `[demo] unhandled migration status ${fm.status} for ${fm.id}`,
    );
  }

  private async advanceDrain(cfg: DemoConfigEntity): Promise<void> {
    const started = cfg.drainStartedAt
      ? new Date(cfg.drainStartedAt).getTime()
      : 0;
    if (Date.now() - started < cfg.drainMinutes * 60_000) return;

    // Tear down the drained source BEFORE closing the window: killing its pods
    // can still disrupt stale-DNS clients, and that loss must count as migration.
    let cleanupOwed: string | null = null;
    if (cfg.activeFullMigrationId) {
      try {
        await this.fullMig.destroySource(cfg.activeFullMigrationId);
      } catch (err: any) {
        this.logger.warn(
          `[demo] destroy-source failed: ${err?.message ?? err}`,
        );
        cleanupOwed = cfg.activeFullMigrationId;
      }
    }

    await this.state.patch({ windowOpen: false });
    this.events.emit(DemoEventType.WINDOW_CLOSED, {
      ts: new Date().toISOString(),
    });

    const durationMs = cfg.cycleStartedAt
      ? Date.now() - new Date(cfg.cycleStartedAt).getTime()
      : null;
    await this.state.patch({
      state: DemoLoopState.IDLE,
      activeFullMigrationId: null,
      pendingCleanupMigrationId: cleanupOwed,
      lastCycleAt: new Date(),
      lastCycleDurationMs: durationMs,
      cycleCount: cfg.cycleCount + 1,
    });
    this.events.emit(DemoEventType.CYCLE_COMPLETED, {
      cycleCount: cfg.cycleCount + 1,
      currentClusterId: cfg.currentClusterId,
      durationMs,
      ts: new Date().toISOString(),
    });
    this.logger.log(
      `[demo] cycle #${cfg.cycleCount + 1} complete in ${durationMs ?? '?'}ms`,
    );
  }

  private async requestCutover(
    cfg: DemoConfigEntity,
    fm: FullMigrationEntity,
    force = false,
  ): Promise<void> {
    const recent =
      !force &&
      cfg.cutoverRequestedAt &&
      Date.now() - new Date(cfg.cutoverRequestedAt).getTime() <
        CUTOVER_GRACE_MS;
    if (recent) return; // a cutover job is already in flight; don't double-enqueue
    await this.state.patch({ cutoverRequestedAt: new Date() });
    try {
      await this.fullMig.cutover(fm.id);
    } catch (err: any) {
      await this.state.patch({ cutoverRequestedAt: null });
      this.logger.warn(
        `[demo] cutover enqueue failed for ${fm.id}: ${err?.message ?? err}`,
      );
    }
  }

  private async clearPendingCleanup(): Promise<void> {
    const cfg = await this.state.get();
    if (!cfg.pendingCleanupMigrationId) return;
    try {
      await this.fullMig.destroySource(cfg.pendingCleanupMigrationId);
      await this.state.patch({ pendingCleanupMigrationId: null });
    } catch (err: any) {
      throw new Error(
        `owed source cleanup still failing: ${err?.message ?? err}`,
      );
    }
  }

  private emitProgress(fm: FullMigrationEntity): void {
    if (fm.status === this.lastEmittedStatus) return;
    this.lastEmittedStatus = fm.status;
    this.events.emit(DemoEventType.MIGRATION_PROGRESS, {
      migrationId: fm.id,
      status: fm.status,
      ts: new Date().toISOString(),
    });
  }

  private pickTarget(cfg: DemoConfigEntity, currentClusterId: string): string {
    if (currentClusterId === cfg.clusterAId) return cfg.clusterBId;
    if (currentClusterId === cfg.clusterBId) return cfg.clusterAId;
    throw new Error(
      `Demo app is on cluster ${currentClusterId}, not in the configured pair ` +
        `(${cfg.clusterAId}, ${cfg.clusterBId}).`,
    );
  }

  private configError(cfg: DemoConfigEntity): string | null {
    const missing: string[] = [];
    if (!cfg.appId) missing.push('appId');
    if (!cfg.dbAppId) missing.push('dbAppId');
    if (!cfg.clusterAId) missing.push('clusterAId');
    if (!cfg.clusterBId) missing.push('clusterBId');
    if (!cfg.ownerUserId) missing.push('ownerUserId');
    if (missing.length) {
      return `demo config incomplete: missing ${missing.join(', ')}`;
    }
    if (cfg.clusterAId === cfg.clusterBId) {
      return 'clusterAId and clusterBId must differ';
    }
    return null;
  }

  private async retryStartOrFail(
    cfg: DemoConfigEntity,
    reason: string,
  ): Promise<void> {
    const strikes = (cfg.strikes ?? 0) + 1;
    if (strikes >= MAX_STRIKES) {
      return this.hardFail(`${reason} (after ${strikes} strikes)`, false);
    }
    await this.state.patch({
      state: DemoLoopState.IDLE,
      activeFullMigrationId: null,
      strikes,
      lastError: reason,
    });
    this.logger.warn(
      `[demo] retryable start failure (${strikes}/${MAX_STRIKES}): ${reason}`,
    );
  }

  private async bumpStrikeOrFail(
    cfg: DemoConfigEntity,
    reason: string,
  ): Promise<void> {
    const strikes = (cfg.strikes ?? 0) + 1;
    if (strikes >= MAX_STRIKES) {
      return this.hardFail(
        `${reason} (after ${strikes} strikes)`,
        cfg.windowOpen,
      );
    }
    await this.state.patch({ strikes, lastError: reason });
    this.logger.warn(`[demo] transient (${strikes}/${MAX_STRIKES}): ${reason}`);
  }

  private async hardFail(
    reason: string,
    keepWindowOpen: boolean,
    currentClusterId?: string,
  ): Promise<void> {
    this.logger.error(`[demo] ${reason}`);
    const patch: Partial<DemoConfigEntity> = {
      state: DemoLoopState.FAILED,
      windowOpen: keepWindowOpen,
      lastError: reason,
    };
    if (currentClusterId) patch.currentClusterId = currentClusterId;
    await this.state.patch(patch);
    this.events.emit(DemoEventType.CYCLE_FAILED, {
      reason: PUBLIC_FAILURE,
      ts: new Date().toISOString(),
    });
  }
}
