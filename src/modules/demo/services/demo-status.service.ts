import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { FullMigrationService } from '../../full-migration/services/full-migration.service';
import { DemoStateService } from './demo-state.service';
import { DemoProberService } from './demo-prober.service';

export interface DemoStatusSnapshot {
  enabled: boolean;
  state: string;
  provisionMode: string;
  windowOpen: boolean;
  current: {
    clusterId: string | null;
    provider: string | null;
    ip: string | null;
  };
  activeMigration: { id: string; status: string | null } | null;
  cycleCount: number;
  lastCycleAt: string | null;
  lastCycleDurationMs: number | null;
  lastError: string | null;
  counters: {
    served: number;
    failed: number;
    lostDuringMigration: number;
    total: number;
    successRatePct: number | null;
    lastProbeAt: string | null;
    lastProbeOk: boolean | null;
  };
  ts: string;
}

@Injectable()
export class DemoStatusService {
  constructor(
    private readonly state: DemoStateService,
    private readonly prober: DemoProberService,
    private readonly fullMig: FullMigrationService,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
  ) {}

  async snapshot(): Promise<DemoStatusSnapshot> {
    const cfg = await this.state.get();
    const counters = this.prober.snapshot();

    let cluster: ClusterEntity | null = null;
    if (cfg.currentClusterId) {
      cluster = await this.clusterRepo.findOne({
        where: { id: cfg.currentClusterId },
      });
    }

    let activeMigration: { id: string; status: string | null } | null = null;
    if (cfg.activeFullMigrationId) {
      let status: string | null = null;
      try {
        const fm = await this.fullMig.findById(cfg.activeFullMigrationId);
        status = fm.status;
      } catch {
        status = null;
      }
      activeMigration = { id: cfg.activeFullMigrationId, status };
    }

    const successRatePct =
      counters.probesTotal > 0
        ? Math.round((counters.probesOk / counters.probesTotal) * 10000) / 100
        : null;

    return {
      enabled: cfg.enabled,
      state: cfg.state,
      provisionMode: cfg.provisionMode,
      windowOpen: cfg.windowOpen,
      current: {
        clusterId: cfg.currentClusterId ?? null,
        provider: cluster?.provider ?? null,
        ip: cluster?.masterIpAddress ?? null,
      },
      activeMigration,
      cycleCount: cfg.cycleCount,
      lastCycleAt: cfg.lastCycleAt
        ? new Date(cfg.lastCycleAt).toISOString()
        : null,
      lastCycleDurationMs: cfg.lastCycleDurationMs ?? null,
      // Public: a generic phrase only — the raw error stays on admin GET /config.
      lastError: cfg.lastError ? 'migration failed; operator notified' : null,
      counters: {
        served: counters.probesOk,
        failed: counters.probesFailed,
        lostDuringMigration: counters.failedDuringMigration,
        total: counters.probesTotal,
        successRatePct,
        lastProbeAt: counters.lastProbeAt,
        lastProbeOk: counters.lastProbeOk,
      },
      ts: new Date().toISOString(),
    };
  }
}
