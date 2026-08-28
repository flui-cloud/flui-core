import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity } from '../entities/cluster-node.entity';
import { NodeBillableIntervalEntity } from '../entities/node-billable-interval.entity';
import {
  FleetHistoryDto,
  FleetHistoryPointDto,
} from '../dto/fleet-history.dto';
import { NodePriceService } from './node-price.service';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const DEFAULT_STEP_HOURS = 24;
const MAX_STEP_HOURS = 24 * 7;
/** Above this the answer stops being a chart and starts being a scan. */
const MAX_POINTS = 400;

/** A node whose provider records no size, kept distinct from a real shape. */
export const UNKNOWN_SHAPE = 'unknown';

export interface FleetInterval {
  startedAt: number;
  endedAt: number | null;
  shape: string;
  hourlyEur: number | null;
}

export interface FleetHistoryOptions {
  days?: number;
  stepHours?: number;
}

/**
 * The intervals record the provider's own name where BYOS had nothing to
 * record. Carried into a chart it would draw a band called `byos` beside
 * `cx32` and read as a size somebody could buy.
 */
export function resolveShape(interval: {
  provider: string;
  serverType?: string | null;
}): string {
  const serverType = interval.serverType?.trim();
  if (!serverType) return UNKNOWN_SHAPE;
  return serverType.toLowerCase() === interval.provider.toLowerCase()
    ? UNKNOWN_SHAPE
    : serverType;
}

/**
 * How many nodes of each shape were alive at each sample, and what they cost
 * per hour. One series per shape, because "3 nodes" says neither whether the
 * next pod fits nor why the bill moved; which three does.
 */
export function sampleFleet(
  intervals: FleetInterval[],
  from: number,
  to: number,
  stepMs: number,
): FleetHistoryPointDto[] {
  const points: FleetHistoryPointDto[] = [];

  for (let at = from; at <= to; at += stepMs) {
    const byShape: Record<string, number> = {};
    let nodes = 0;
    let hourlyEur = 0;
    let unpricedNodes = 0;

    for (const interval of intervals) {
      const alive =
        interval.startedAt <= at &&
        (interval.endedAt === null || interval.endedAt > at);
      if (!alive) continue;

      byShape[interval.shape] = (byShape[interval.shape] ?? 0) + 1;
      nodes++;
      if (interval.hourlyEur === null) unpricedNodes++;
      else hourlyEur += interval.hourlyEur;
    }

    points.push({
      at: new Date(at),
      byShape,
      nodes,
      // Six decimals is the column's own precision; summing floats past it
      // produces a cost that changes in the last digit between two identical
      // fleets.
      hourlyEur: Number(hourlyEur.toFixed(6)),
      unpricedNodes,
    });
  }

  return points;
}

/**
 * The fleet over time, counted from the lifetimes billing already records.
 *
 * On orphaned intervals — a row whose node was deleted, which the schema
 * permits because `infrastructure_cluster_nodes` cascades on cluster delete
 * while this table carries no foreign key at all — the choice is to **count
 * them and say how many**. The interval is the record of a machine that ran
 * and was charged for; dropping it would draw a fleet smaller than the one the
 * bill describes. What that risks is the opposite error on an interval still
 * open, so those are reported on their own line rather than folded in.
 */
@Injectable()
export class FleetHistoryService {
  private readonly logger = new Logger(FleetHistoryService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepository: Repository<ClusterNodeEntity>,
    @InjectRepository(NodeBillableIntervalEntity)
    private readonly intervalRepository: Repository<NodeBillableIntervalEntity>,
    private readonly nodePriceService: NodePriceService,
  ) {}

  async getHistory(
    clusterId: string,
    options: FleetHistoryOptions = {},
  ): Promise<FleetHistoryDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const { from, to, stepMs } = this.resolveWindow(options);
    const rows = await this.loadIntervals(clusterId, from, to);
    const priced = await this.price(rows);

    const orphaned = priced.filter((entry) => entry.orphaned);
    const orphanedOpen = orphaned.filter((entry) => !entry.interval.endedAt);

    return {
      clusterId,
      from: new Date(from),
      to: new Date(to),
      stepSeconds: stepMs / 1000,
      points: sampleFleet(
        priced.map((entry) => entry.fleet),
        from,
        to,
        stepMs,
      ),
      orphanedIntervals: orphaned.length,
      orphanedOpenIntervals: orphanedOpen.length,
      message: this.describe(orphaned.length, orphanedOpen.length),
    };
  }

  private resolveWindow(options: FleetHistoryOptions): {
    from: number;
    to: number;
    stepMs: number;
  } {
    const days = clamp(options.days ?? DEFAULT_DAYS, 1, MAX_DAYS);
    const stepHours = clamp(
      options.stepHours ?? DEFAULT_STEP_HOURS,
      1,
      MAX_STEP_HOURS,
    );
    const to = Date.now();
    const span = days * DAY_MS;
    // Widened rather than truncated, so a long window answers about the whole
    // span it was asked about instead of about its tail.
    const stepMs = Math.max(stepHours * HOUR_MS, span / MAX_POINTS);
    return { from: to - span, to, stepMs };
  }

  private loadIntervals(
    clusterId: string,
    from: number,
    to: number,
  ): Promise<NodeBillableIntervalEntity[]> {
    return this.intervalRepository
      .createQueryBuilder('interval')
      .where('interval.clusterId = :clusterId', { clusterId })
      .andWhere('interval.startedAt <= :to', { to: new Date(to) })
      .andWhere('(interval.endedAt IS NULL OR interval.endedAt >= :from)', {
        from: new Date(from),
      })
      .orderBy('interval.startedAt', 'ASC')
      .getMany();
  }

  /**
   * The node's own recorded price first: it is what that machine cost, while
   * the catalogue answers what its shape costs today.
   */
  private async price(rows: NodeBillableIntervalEntity[]): Promise<
    Array<{
      interval: NodeBillableIntervalEntity;
      fleet: FleetInterval;
      orphaned: boolean;
    }>
  > {
    const nodeIds = [...new Set(rows.map((row) => row.nodeId))];
    const nodes = nodeIds.length
      ? await this.nodeRepository.find({ where: { id: In(nodeIds) } })
      : [];
    const byNodeId = new Map(nodes.map((node) => [node.id, node]));

    const catalogue = new Map<string, number | null>();
    const out: Array<{
      interval: NodeBillableIntervalEntity;
      fleet: FleetInterval;
      orphaned: boolean;
    }> = [];

    for (const interval of rows) {
      const node = byNodeId.get(interval.nodeId);
      const shape = resolveShape(interval);
      let hourlyEur = node?.hourlyPriceEur ?? null;

      if (hourlyEur === null && shape !== UNKNOWN_SHAPE) {
        const location = interval.location ?? interval.region;
        const key = `${interval.provider}|${shape}|${location}`;
        if (!catalogue.has(key)) {
          catalogue.set(
            key,
            await this.lookup(interval.provider, shape, location),
          );
        }
        hourlyEur = catalogue.get(key) ?? null;
      }

      out.push({
        interval,
        orphaned: !node,
        fleet: {
          startedAt: interval.startedAt.getTime(),
          endedAt: interval.endedAt ? interval.endedAt.getTime() : null,
          shape,
          hourlyEur,
        },
      });
    }

    return out;
  }

  private async lookup(
    provider: string,
    shape: string,
    location: string | null,
  ): Promise<number | null> {
    try {
      return await this.nodePriceService.resolveHourlyEur(
        provider,
        shape,
        location,
      );
    } catch (err) {
      this.logger.warn(
        `Price unavailable for ${provider}/${shape}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private describe(orphaned: number, orphanedOpen: number): string | null {
    if (!orphaned) return null;
    const counted =
      `${orphaned} interval(s) in this window describe a node that no longer ` +
      `exists. They are counted — the machine ran and was billed for.`;
    if (!orphanedOpen) return counted;
    return (
      `${counted} ${orphanedOpen} of them are still open, which means the ` +
      `latest samples may include a node that is already gone.`
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
