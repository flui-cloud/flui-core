import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Not, Repository } from 'typeorm';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';

/** What one tenancy actually holds on the cluster, in millicores and MiB. */
export interface TenancyFootprint {
  cpu: number;
  memory: number;
  /** How it was arrived at, so a wrong ceiling can be traced to a wrong input. */
  source: 'measured' | 'declared';
  sampledFrom: number;
}

export interface SandboxCapacity {
  /** Built and waiting for a visitor. */
  warm: number;
  /** Held by someone right now. */
  live: number;
  /** How many were taken in the last hour, and per hour over the last day. */
  claimsLastHour: number;
  claimsPerHourToday: number;
  /** The rate the target is computed from: the higher of the two above. */
  demandPerHour: number;
  /** How many warm tenancies the demand asks for right now. */
  target: number;
  /** The most tenancies this cluster can hold at once, as it is today. */
  ceiling: number;
  /** Seconds from "start building" to "safe to hand to a visitor". */
  readySeconds: number;
  footprint: TenancyFootprint;
  /** Times a visitor was turned away because nothing was warm. */
  fullRefusals: number;
  /** One sentence a human can read instead of recomputing the arithmetic. */
  reason: string;
}

/**
 * How many tenancies to keep warm, and how many this cluster can hold at all.
 *
 * The old answer was a number in the environment. A number cannot be right: set
 * low it makes visitors wait for a build, set high it pays for tenancies nobody
 * asked for, and either way it says nothing about the machine it is running on.
 *
 * The answer here is arithmetic over two measurements. **Demand** is how many
 * areas are being taken per hour, read from the tenancies themselves. **Cost**
 * is how long an area takes to become safe to hand over — which is not the same
 * as how long it takes to build, because for a further minute after that the
 * application inside it is running but its public address does not resolve yet.
 * Keep enough warm to cover the arrivals expected while one is being replaced,
 * plus one, so the first visitor of a quiet night does not wait either.
 *
 * The ceiling is the room the cluster actually has, divided by what a tenancy
 * actually holds — both read from the cluster rather than declared. This is the
 * part that earns autoscaling for free: when a node is added the ceiling rises
 * on its own, and nothing about the rule changes.
 */
@Injectable()
export class SandboxCapacityService {
  private readonly logger = new Logger(SandboxCapacityService.name);

  /**
   * Measured: 126s to build, then a further 76s
   * before the seeded application answers on its own public address. Handing
   * over a tenancy whose address is still dead is what the second half pays
   * for. The build half is overridden by what builds actually take.
   *
   * The settle half is the cost of publishing a **per-app DNS record** and
   * waiting for a resolver to see a name that did not exist a minute ago. It is
   * not the certificate: that comes from the cluster wildcard and is already in
   * place. On a zone that publishes a wildcard record covering the application
   * hostnames, no per-app record is written at all (see
   * `wildcardCoveringRecord` in the endpoint reconciliation) and this is
   * **zero** — set it so, and the buffer shrinks accordingly.
   */
  private static readonly DECLARED_BUILD_SECONDS = 126;
  private static readonly DECLARED_SETTLE_SECONDS = 76;

  /**
   * The seed's own requests, used only until a living tenancy can be measured.
   * A tenancy is allowed to request far more than this — the quota caps it at
   * 1500m — but quota is a ceiling, not a reservation, and sizing the cluster
   * against a ceiling nobody reaches would refuse visitors it could hold.
   */
  private static readonly DECLARED_FOOTPRINT: TenancyFootprint = {
    cpu: 500,
    memory: 512,
    source: 'declared',
    sampledFrom: 0,
  };

  private static readonly CACHE_MS = 10_000;

  private readonly buildSamples: number[] = [];
  private fullRefusals = 0;
  private cache: { at: number; value: SandboxCapacity } | null = null;

  constructor(
    @InjectRepository(SandboxTenantEntity)
    private readonly tenants: Repository<SandboxTenantEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  /** Fed by every finished build, so the rule corrects itself as the seed changes. */
  recordBuild(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.buildSamples.push(seconds);
    if (this.buildSamples.length > 20) this.buildSamples.shift();
    // A finished build changes both halves of the answer — one more warm, and a
    // fresh reading of what a build costs.
    this.cache = null;
  }

  /** Fed by the claim path, so "we turned people away" is a number and not a log line. */
  recordFullRefusal(): void {
    this.fullRefusals += 1;
  }

  /**
   * Seconds from starting a build to being able to hand the result to somebody.
   *
   * The median rather than the mean: one build that hit a slow image pull must
   * not double the buffer for the rest of the day.
   */
  readySeconds(): number {
    const build =
      this.buildSamples.length > 0
        ? median(this.buildSamples)
        : SandboxCapacityService.DECLARED_BUILD_SECONDS;
    return Math.round(build + SandboxCapacityService.DECLARED_SETTLE_SECONDS);
  }

  async claimsSince(ms: number): Promise<number> {
    return this.tenants.count({
      where: { claimedAt: MoreThan(new Date(Date.now() - ms)) },
    });
  }

  /**
   * Areas being taken per hour.
   *
   * Two windows, and the larger wins. The last hour on its own is jumpy at the
   * volumes a demo sees — one visitor is either zero or sixty per hour — and the
   * day on its own would still be building for a rush that ended this morning.
   * Taking the larger means a burst raises the buffer immediately and a quiet
   * hour after a busy day does not empty it.
   */
  async demandPerHour(): Promise<{
    lastHour: number;
    perHourToday: number;
    rate: number;
  }> {
    const [lastHour, lastDay] = await Promise.all([
      this.claimsSince(3_600_000),
      this.claimsSince(86_400_000),
    ]);
    const perHourToday = lastDay / 24;
    return { lastHour, perHourToday, rate: Math.max(lastHour, perHourToday) };
  }

  /** Tenancies alive on the cluster: warm ones and held ones both cost the same. */
  private async counts(): Promise<{ warm: number; live: number }> {
    const [warm, live] = await Promise.all([
      this.tenants.count({ where: { state: SandboxTenantState.READY } }),
      this.tenants.count({ where: { state: SandboxTenantState.CLAIMED } }),
    ]);
    return { warm, live };
  }

  /**
   * What a tenancy actually holds, averaged over the ones that exist.
   *
   * Measured rather than declared because the seed is free to change and a
   * guest is free to deploy on top of it; a constant here would go stale in the
   * direction that oversubscribes the machine.
   */
  async footprint(kubeconfig: string): Promise<TenancyFootprint> {
    const living = await this.tenants.find({
      where: [
        { state: SandboxTenantState.READY },
        { state: SandboxTenantState.CLAIMED },
      ],
      select: { namespace: true },
      take: 10,
    });
    if (living.length === 0) return SandboxCapacityService.DECLARED_FOOTPRINT;

    let cpu = 0;
    let memory = 0;
    let sampled = 0;
    for (const { namespace } of living) {
      try {
        const pods: { spec?: { containers?: unknown[] } }[] =
          await this.k8s.listResources(kubeconfig, 'pod', namespace);
        for (const pod of pods) {
          for (const container of (pod.spec?.containers ?? []) as {
            resources?: { requests?: Record<string, string> };
          }[]) {
            const requests = container.resources?.requests ?? {};
            cpu += this.k8s.parseCpu(requests['cpu'] ?? '0');
            memory += this.k8s.parseMemory(requests['memory'] ?? '0');
          }
        }
        sampled += 1;
      } catch (error) {
        this.logger.debug(
          `Could not measure ${namespace}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (sampled === 0) return SandboxCapacityService.DECLARED_FOOTPRINT;

    return {
      cpu: Math.round(cpu / sampled),
      memory: Math.round(memory / sampled),
      source: 'measured',
      sampledFrom: sampled,
    };
  }

  /**
   * The nodes a tenancy may actually land on.
   *
   * The same rule the seed places against: workers, plus the control-plane node
   * only where that has been deliberately allowed for a single-node test
   * cluster. Counting a node nothing can be scheduled on would produce a
   * ceiling that turns into pending pods.
   */
  private async placeableCapacity(
    kubeconfig: string,
  ): Promise<{ freeCpu: number; freeMemory: number; nodes: number }> {
    const workers = await this.k8s.listWorkerNodeCapacities(kubeconfig);
    const nodes = workers.map((w) => ({
      free: w.free.cpu,
      freeMemory: w.free.memory,
    }));

    if (this.config.allowMasterPlacement) {
      const master = await this.k8s.getMasterNodeCapacity(kubeconfig);
      if (master) {
        nodes.push({
          free: master.allocatable.cpu - master.requested.cpu,
          freeMemory: master.allocatable.memory - master.requested.memory,
        });
      }
    }

    return {
      freeCpu: nodes.reduce((sum, n) => sum + Math.max(0, n.free), 0),
      freeMemory: nodes.reduce((sum, n) => sum + Math.max(0, n.freeMemory), 0),
      nodes: nodes.length,
    };
  }

  /**
   * Everything the rule is made of, in one read.
   *
   * Assembled together rather than exposed as separate getters because the
   * numbers only mean anything next to each other: a target of four is a
   * different thing under a ceiling of five than under a ceiling of forty.
   */
  async snapshot(): Promise<SandboxCapacity> {
    // Held for a few seconds because the moment this is asked most often is a
    // rush — every refused visitor asks it to be told when to come back — and
    // that is exactly the moment the cluster should not also be answering a
    // node-and-pod listing per refusal. Far shorter than a build, so the
    // builder still re-reads between one tenancy and the next.
    const cached = this.cache;
    if (cached && Date.now() - cached.at < SandboxCapacityService.CACHE_MS) {
      return { ...cached.value, fullRefusals: this.fullRefusals };
    }
    const value = await this.computeSnapshot();
    this.cache = { at: Date.now(), value };
    return value;
  }

  private async computeSnapshot(): Promise<SandboxCapacity> {
    const [{ warm, live }, demand] = await Promise.all([
      this.counts(),
      this.demandPerHour(),
    ]);
    const readySeconds = this.readySeconds();
    const expected = (demand.rate * readySeconds) / 3600;
    const wanted = Math.ceil(expected) + 1;

    let footprint = SandboxCapacityService.DECLARED_FOOTPRINT;
    let ceiling = warm + live;
    let capacityRead = false;
    try {
      const kubeconfig = await this.kubeconfig();
      footprint = await this.footprint(kubeconfig);
      const room = await this.placeableCapacity(kubeconfig);
      const byCpu = Math.floor(room.freeCpu / Math.max(1, footprint.cpu));
      const byMemory = Math.floor(
        room.freeMemory / Math.max(1, footprint.memory),
      );
      ceiling = warm + live + Math.max(0, Math.min(byCpu, byMemory));
      capacityRead = true;
    } catch (error) {
      // A cluster we cannot read is not a cluster with no room: refusing to
      // build would empty the buffer over a transient API blip. Hold what
      // exists and say so.
      this.logger.warn(
        `Could not read cluster capacity: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const headroom = Math.max(0, ceiling - live);
    const target = Math.max(0, Math.min(wanted, headroom));

    return {
      warm,
      live,
      claimsLastHour: demand.lastHour,
      claimsPerHourToday: Number(demand.perHourToday.toFixed(2)),
      demandPerHour: Number(demand.rate.toFixed(2)),
      target,
      ceiling,
      readySeconds,
      footprint,
      fullRefusals: this.fullRefusals,
      reason: describe({
        capacityRead,
        rate: demand.rate,
        readySeconds,
        wanted,
        target,
        ceiling,
        live,
      }),
    };
  }

  /** How many to start building right now. Never negative. */
  async missing(): Promise<number> {
    const { warm, target } = await this.snapshot();
    return Math.max(0, target - warm);
  }

  private async kubeconfig(): Promise<string> {
    if (!this.config.clusterId)
      throw new Error('No sandbox cluster configured');
    const cluster = await this.clusters.findOne({
      where: { id: this.config.clusterId, kubeconfigEncrypted: Not('') },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new Error(`Cluster ${this.config.clusterId} has no kubeconfig`);
    }
    return this.encryption.decrypt(cluster.kubeconfigEncrypted);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function describe(input: {
  capacityRead: boolean;
  rate: number;
  readySeconds: number;
  wanted: number;
  target: number;
  ceiling: number;
  live: number;
}): string {
  if (!input.capacityRead) {
    return 'The cluster could not be read, so the ceiling is only what already exists; nothing new is being built until it can be.';
  }
  if (input.target < input.wanted) {
    return `Demand asks for ${input.wanted} warm, but the cluster holds ${input.ceiling} tenancies and ${input.live} are taken — so ${input.target}. Past that a visitor is told the sandbox is full rather than handed something that will not schedule.`;
  }
  return `${input.rate.toFixed(1)} claims an hour, and ${input.readySeconds}s to build and settle one, so about ${(
    (input.rate * input.readySeconds) /
    3600
  ).toFixed(1)} would arrive during a build — keep ${input.target} warm.`;
}
