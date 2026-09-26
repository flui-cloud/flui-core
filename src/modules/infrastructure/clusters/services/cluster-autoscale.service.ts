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
import { ClusterBoundsRegistry } from './cluster-bounds.registry';
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
    private readonly bounds: ClusterBoundsRegistry,
  ) {}

  getDefaults(): AutoscaleThresholds {
    return AUTOSCALE_DEFAULTS;
  }

  resolveEffectiveThresholds(
    cluster: ClusterEntity,
  ): AutoscaleEffectiveThresholdsDto {
    return {
      // Installation-wide, not per cluster: the per-cluster overrides were
      // stored and read by nothing, so a number set there changed no behaviour.
      scaleUpMemoryPct: AUTOSCALE_DEFAULTS.scaleUpMemoryPct,
      scaleUpCpuPct: AUTOSCALE_DEFAULTS.scaleUpCpuPct,
      warnMemoryPct: AUTOSCALE_DEFAULTS.warnMemoryPct,
      dangerMemoryPct: AUTOSCALE_DEFAULTS.dangerMemoryPct,
      warnCpuPct: AUTOSCALE_DEFAULTS.warnCpuPct,
      dangerCpuPct: AUTOSCALE_DEFAULTS.dangerCpuPct,
      cooldownSeconds: AUTOSCALE_DEFAULTS.cooldownSeconds,
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

    const nextMin = dto.minNodes ?? cluster.minNodes;
    const nextMax = dto.maxNodes ?? cluster.maxNodes;

    // The bounds are checked whenever either is present. They used to be
    // checked only behind a flag that decided nothing, so a floor above a
    // ceiling was storable on any cluster the flag happened to be off for.
    if (nextMin != null && nextMax != null && nextMin > nextMax) {
      throw new BadRequestException(
        'The floor cannot sit above the ceiling: minNodes must be <= maxNodes',
      );
    }

    // Where a scaling group owns this cluster's bounds, the numbers go there:
    // stored only on the cluster they would look set and fence nothing.
    if (dto.minNodes !== undefined || dto.maxNodes !== undefined) {
      const taken = await this.bounds.writeBounds(cluster.id, {
        min: nextMin ?? null,
        max: nextMax ?? null,
      });
      // Someone owns these bounds but could not take them — several groups on
      // one cluster, and no way to tell which was meant. Storing them on the
      // cluster row instead would leave a number that looks set and fences
      // nothing, which is the failure this whole route was rewired to avoid.
      if (!taken && (await this.bounds.boundsFor(cluster.id))) {
        throw new BadRequestException(
          'This cluster has several scaling groups; set the floor and ceiling on the group that should carry them.',
        );
      }
    }

    Object.assign(cluster, {
      minNodes: nextMin,
      maxNodes: nextMax,
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
    const owned = await this.bounds.boundsFor(cluster.id);

    const warning = this.computeWarning(
      memoryPct,
      cpuPct,
      effective,
      actuation.actuation,
    );

    return {
      clusterId: cluster.id,
      autoscalingEnabled: cluster.autoscalingEnabled,
      minNodes: owned ? owned.min : cluster.minNodes,
      maxNodes: owned ? owned.max : cluster.maxNodes,
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
        message: `Cluster under heavy load: ${reason}. ${this.describeRelief(actuation)}`,
      };
    }

    // Pressure matters where nothing will relieve it on its own. The flag this
    // used to read said nothing about that, so with it on the warning could
    // never fire and the page went straight from calm to critical.
    if ((memWarn || cpuWarn) && actuation !== AutoscaleActuation.AUTOMATIC) {
      const reason = memWarn
        ? `memory at ${memoryPct.toFixed(1)}%`
        : `CPU at ${cpuPct.toFixed(1)}%`;
      return {
        level: AutoscaleWarningLevel.WARN_NEEDS_AUTOSCALE,
        message:
          `Sustained pressure detected (${reason}) and nothing adds a node on its own here. ` +
          this.describeRelief(actuation),
      };
    }

    return { level: AutoscaleWarningLevel.NONE, message: null };
  }

  /** What would actually relieve the pressure here — never "the autoscaler will". */
  /**
   * What would relieve the pressure, in terms of what this cluster can do.
   * A flag no longer decides any of it: what decides is whether a scaling
   * group on a provider that can buy is set to buy.
   */
  private describeRelief(actuation: AutoscaleActuation): string {
    if (isAlertOnly(actuation)) {
      return 'Flui cannot create a server on this provider — attach one yourself and connect it, or free capacity.';
    }
    if (actuation === AutoscaleActuation.AUTOMATIC) {
      return 'Scaling should add a node within its settle window.';
    }
    return 'Add a worker, or set this cluster’s scaling group to buy automatically.';
  }
}
