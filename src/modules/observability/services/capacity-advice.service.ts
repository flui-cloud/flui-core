import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AppManagementService } from '../../applications/services/app-management.service';
import { rangeOf } from '../../applications/services/app-autoscaling.service';
import { ApplicationService } from '../../applications/services/application.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { DrainFeasibilityService } from '../../infrastructure/scaling/engine/drain-feasibility.service';
import { ScalingEngineService } from '../../infrastructure/scaling/engine/scaling-engine.service';
import {
  cpuMillicoresOf,
  memoryMiOf,
} from '../../shared/utils/resource-quantity.util';
import { AppHealthChecksService } from './app-health-checks.service';
import { ApplicationMetricsService } from './application-metrics.service';
import {
  CapacityInput,
  CapacityMeasures,
  CapacityThresholds,
  CapacityVerdict,
  adviseCapacity,
  capacityThresholds,
  measuresFrom,
  placedByCluster,
} from './capacity-advice.core';

export interface CapacityAdviceResult extends CapacityVerdict {
  appId: string;
  desired: number;
  ready: number;
  measures: CapacityMeasures;
  nextCopy: { verdict: string; sentence: string } | null;
  thresholds: CapacityThresholds;
}

const quantity = (parse: (q: string) => number, value?: string | null) => {
  if (!value) return 0;
  try {
    return parse(value);
  } catch {
    return 0;
  }
};

const askOf = (
  containers: Array<{
    requests: { cpu?: string | null; memory?: string | null };
  }>,
) => ({
  cpuMillicores: containers.reduce(
    (sum, c) => sum + quantity(cpuMillicoresOf, c.requests.cpu),
    0,
  ),
  memoryMi: containers.reduce(
    (sum, c) => sum + quantity(memoryMiOf, c.requests.memory),
    0,
  ),
});

/** More copies, a node for them, or neither: computed once here for every surface. */
@Injectable()
export class CapacityAdviceService {
  private readonly logger = new Logger(CapacityAdviceService.name);

  constructor(
    private readonly applications: ApplicationService,
    private readonly management: AppManagementService,
    private readonly metrics: ApplicationMetricsService,
    private readonly healthChecks: AppHealthChecksService,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async advise(appId: string): Promise<CapacityAdviceResult> {
    const thresholds = capacityThresholds();
    const app = await this.applications.findById(appId);
    const end = Math.floor(Date.now() / 1000);
    const [runtime, points, checks] = await Promise.all([
      this.management.getRuntimeStatus(appId).catch(() => null),
      this.metrics
        .getAppMetricsHistory(
          appId,
          app.slug,
          app.k8sNamespace,
          end - thresholds.windowMinutes * 60,
          end,
          '60s',
        )
        .catch(() => []),
      this.healthChecks.failures(app),
    ]);

    const desired = runtime?.replicas.desired ?? app.replicas ?? 1;
    const input: CapacityInput = {
      kind: app.workloadKind ?? 'Deployment',
      desired,
      ready: runtime?.replicas.ready ?? 0,
      autoscaling: rangeOf(app.scaling),
      waitingForNode: runtime?.waitingForRoom ?? null,
      nextCopy: null,
      measures: measuresFrom(points, checks),
    };

    let verdict = adviseCapacity(input, thresholds);
    if (verdict.advice === 'add_replicas' && runtime) {
      const ask = askOf(runtime.containers);
      input.nextCopy = await this.nextCopy(app.clusterId, ask);
      if (input.nextCopy && input.nextCopy.verdict !== 'fits') {
        input.fitsInMargin = await this.placedByCluster(app.clusterId, ask);
        if (input.fitsInMargin) {
          input.nextCopy = {
            verdict: 'margin',
            sentence:
              'The cluster places it now, in the margin Flui keeps free on each node; a node is bought only if a copy has to wait.',
          };
        }
      }
      verdict = adviseCapacity(input, thresholds);
    }

    return {
      appId,
      ...verdict,
      desired,
      ready: input.ready,
      measures: input.measures,
      nextCopy: input.nextCopy,
      thresholds,
    };
  }

  private async placedByCluster(
    clusterId: string,
    ask: { cpuMillicores: number; memoryMi: number },
  ): Promise<boolean> {
    try {
      const drain = this.moduleRef?.get(DrainFeasibilityService, {
        strict: false,
      });
      const cluster = await this.clusters.findOne({ where: { id: clusterId } });
      if (!drain || !cluster) return false;
      const room = await drain.fleetRoom(cluster);
      return room ? placedByCluster(room.nodes, ask) : false;
    } catch {
      return false;
    }
  }

  private async nextCopy(
    clusterId: string,
    ask: { cpuMillicores: number; memoryMi: number },
  ): Promise<{ verdict: string; sentence: string } | null> {
    try {
      const engine = this.moduleRef?.get(ScalingEngineService, {
        strict: false,
      });
      if (!engine) return null;
      const answer = await engine.whatIf(clusterId, { ...ask, replicas: 1 });
      return { verdict: answer.verdict, sentence: answer.sentence };
    } catch (error) {
      this.logger.warn(
        `Could not ask where another copy would run: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
