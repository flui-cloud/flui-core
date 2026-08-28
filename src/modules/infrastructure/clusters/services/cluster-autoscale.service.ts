import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { UpdateClusterAutoscaleDto } from '../dto/update-cluster-autoscale.dto';
import {
  AutoscaleEffectiveThresholdsDto,
  AutoscaleStatusDto,
  AutoscaleWarningLevel,
} from '../dto/autoscale-status.dto';
import {
  AUTOSCALE_DEFAULTS,
  AutoscaleThresholds,
} from '../config/autoscale-defaults';
import { PrometheusQueryService } from '../../../observability/services/prometheus-query.service';
import { AutoscaleActuationService } from './autoscale-actuation.service';
import { AutoscaleActuation, isAlertOnly } from './autoscale-actuation';
import { UnschedulablePodsService } from './unschedulable-pods.service';

@Injectable()
export class ClusterAutoscaleService {
  private readonly logger = new Logger(ClusterAutoscaleService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly prometheusQueryService: PrometheusQueryService,
    private readonly actuationService: AutoscaleActuationService,
    private readonly unschedulablePodsService: UnschedulablePodsService,
  ) {}

  getDefaults(): AutoscaleThresholds {
    return AUTOSCALE_DEFAULTS;
  }

  resolveEffectiveThresholds(
    cluster: ClusterEntity,
  ): AutoscaleEffectiveThresholdsDto {
    return {
      scaleUpMemoryPct:
        cluster.scaleUpMemoryPct ?? AUTOSCALE_DEFAULTS.scaleUpMemoryPct,
      scaleUpCpuPct: cluster.scaleUpCpuPct ?? AUTOSCALE_DEFAULTS.scaleUpCpuPct,
      warnMemoryPct: AUTOSCALE_DEFAULTS.warnMemoryPct,
      dangerMemoryPct: AUTOSCALE_DEFAULTS.dangerMemoryPct,
      warnCpuPct: AUTOSCALE_DEFAULTS.warnCpuPct,
      dangerCpuPct: AUTOSCALE_DEFAULTS.dangerCpuPct,
      cooldownSeconds:
        cluster.cooldownSeconds ?? AUTOSCALE_DEFAULTS.cooldownSeconds,
    };
  }

  async updateAutoscale(
    clusterId: string,
    dto: UpdateClusterAutoscaleDto,
  ): Promise<ClusterEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const nextEnabled = dto.autoscalingEnabled ?? cluster.autoscalingEnabled;
    const nextMin = dto.minNodes ?? cluster.minNodes;
    const nextMax = dto.maxNodes ?? cluster.maxNodes;

    if (nextEnabled) {
      if (nextMin == null || nextMax == null) {
        throw new BadRequestException(
          'minNodes and maxNodes are required when autoscaling is enabled',
        );
      }
      if (nextMin < 1) {
        throw new BadRequestException('minNodes must be >= 1');
      }
      if (nextMin > nextMax) {
        throw new BadRequestException('minNodes must be <= maxNodes');
      }
    }

    if (
      dto.autoscalingEnabled === true &&
      cluster.autoscalingEnabled === false
    ) {
      const vnetId = cluster.metadata?.vnetConfig?.vnetId;
      if (!vnetId) {
        throw new BadRequestException(
          'Cannot enable autoscaling on a cluster without a VNet. ' +
            'Recreate the cluster with autoscalingEnabled=true (a VNet will be created automatically) ' +
            'or attach a VNet manually before enabling.',
        );
      }
    }

    Object.assign(cluster, {
      autoscalingEnabled: nextEnabled,
      minNodes: nextMin,
      maxNodes: nextMax,
      scaleUpMemoryPct: dto.scaleUpMemoryPct ?? cluster.scaleUpMemoryPct,
      scaleUpCpuPct: dto.scaleUpCpuPct ?? cluster.scaleUpCpuPct,
      cooldownSeconds: dto.cooldownSeconds ?? cluster.cooldownSeconds,
    });

    return this.clusterRepository.save(cluster);
  }

  async getStatus(clusterId: string): Promise<AutoscaleStatusDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const effective = this.resolveEffectiveThresholds(cluster);

    let memoryPct: number | null = null;
    let cpuPct: number | null = null;
    try {
      memoryPct =
        await this.prometheusQueryService.getServerMemoryUsage(clusterId);
      cpuPct = await this.prometheusQueryService.getServerCpuUsage(clusterId);
    } catch (error) {
      this.logger.warn(
        `Failed to fetch metrics for cluster ${clusterId}: ${error.message}`,
      );
    }

    const actuation = await this.actuationService.describe(
      cluster.provider,
      cluster.id,
    );
    const unschedulable = await this.unschedulablePodsService.read(cluster);

    const warning = this.computeWarning(
      cluster.autoscalingEnabled,
      memoryPct,
      cpuPct,
      effective,
      actuation.actuation,
    );

    return {
      clusterId: cluster.id,
      autoscalingEnabled: cluster.autoscalingEnabled,
      minNodes: cluster.minNodes,
      maxNodes: cluster.maxNodes,
      currentNodes: cluster.nodes?.length ?? cluster.nodeCount ?? 0,
      metrics: { memoryPct, cpuPct },
      unschedulable,
      warning: warning.level,
      warningMessage: warning.message,
      actuation: actuation.actuation,
      actuationMessage: actuation.message,
      nodeProvisioning: actuation.facts.nodeProvisioning,
      driven: actuation.facts.driven,
      effectiveThresholds: effective,
    };
  }

  computeWarning(
    autoscalingEnabled: boolean,
    memoryPct: number | null,
    cpuPct: number | null,
    thresholds: AutoscaleEffectiveThresholdsDto,
    actuation: AutoscaleActuation,
  ): { level: AutoscaleWarningLevel; message: string | null } {
    const memDanger =
      memoryPct !== null && memoryPct >= thresholds.dangerMemoryPct;
    const cpuDanger = cpuPct !== null && cpuPct >= thresholds.dangerCpuPct;
    const memWarn = memoryPct !== null && memoryPct >= thresholds.warnMemoryPct;
    const cpuWarn = cpuPct !== null && cpuPct >= thresholds.warnCpuPct;

    if (memDanger || cpuDanger) {
      const reason = memDanger
        ? `memory at ${memoryPct.toFixed(1)}% (>= ${thresholds.dangerMemoryPct}%)`
        : `CPU at ${cpuPct.toFixed(1)}% (>= ${thresholds.dangerCpuPct}%)`;
      return {
        level: AutoscaleWarningLevel.DANGER_NEEDS_SCALE,
        message: `Cluster under heavy load: ${reason}. ${this.describeRelief(
          autoscalingEnabled,
          actuation,
        )}`,
      };
    }

    if ((memWarn || cpuWarn) && !autoscalingEnabled) {
      const reason = memWarn
        ? `memory at ${memoryPct.toFixed(1)}%`
        : `CPU at ${cpuPct.toFixed(1)}%`;
      return {
        level: AutoscaleWarningLevel.WARN_NEEDS_AUTOSCALE,
        message:
          `Sustained pressure detected (${reason}) and autoscaling is disabled. ` +
          this.describeRelief(false, actuation),
      };
    }

    return { level: AutoscaleWarningLevel.NONE, message: null };
  }

  /** What would actually relieve the pressure here — never "the autoscaler will". */
  private describeRelief(
    autoscalingEnabled: boolean,
    actuation: AutoscaleActuation,
  ): string {
    if (isAlertOnly(actuation)) {
      return 'Flui cannot create a server on this provider — attach one yourself and connect it, or free capacity.';
    }
    if (actuation === AutoscaleActuation.AUTOMATIC) {
      return autoscalingEnabled
        ? 'Autoscaler should react within the cooldown window.'
        : 'Autoscaling is DISABLED — add a worker or enable autoscaling.';
    }
    return autoscalingEnabled
      ? 'Autoscaling is enabled, but nothing adds a node on its own — add a worker.'
      : 'Autoscaling is DISABLED, and enabling it would not add a node on its own — add a worker.';
  }
}
