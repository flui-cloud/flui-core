import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
import { SandboxCapacityService } from './sandbox-capacity.service';
import { SandboxReserveService } from './sandbox-reserve.service';
import { SandboxTenantService } from './sandbox-tenant.service';
import { SandboxPrepullService } from './sandbox-prepull.service';
import { SandboxTenantState } from '../entities/sandbox-tenant.entity';

/**
 * A pass builds sequentially, so this is also a time bound: eight builds is
 * about a quarter of an hour of one process doing nothing else. Past that the
 * next pass takes over, with a freshly-read demand rather than one from before.
 */
const MAX_BUILDS_PER_PASS = 8;

/**
 * The two loops that keep the demo honest: one deletes what is past its
 * deadline, the other builds back up to what the demand is asking for.
 *
 * They never run concurrently with themselves. A reaper that overlaps its own
 * previous run would try to delete the same namespace twice and log a failure
 * for work that was actually fine; a builder that overlaps would build past the
 * target and pay for tenancies nobody asked for.
 */
@Injectable()
export class SandboxSchedulerService {
  private readonly logger = new Logger(SandboxSchedulerService.name);
  private reaping = false;
  private refilling = false;

  constructor(
    private readonly reserve: SandboxReserveService,
    private readonly capacity: SandboxCapacityService,
    private readonly tenants: SandboxTenantService,
    private readonly prepull: SandboxPrepullService,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async reapExpired(): Promise<void> {
    if (!this.config.enabled || this.reaping) return;
    this.reaping = true;
    try {
      const expired = await this.reserve.findExpired();
      const stale = await this.reserve.findStale();
      const abandoned = await this.reserve.findAbandoned();
      const work = [...expired, ...stale, ...abandoned];
      if (work.length === 0) return;

      this.logger.log(
        `Reaping ${expired.length} expired, ${stale.length} unclaimed and ${abandoned.length} abandoned tenancies`,
      );
      for (const tenant of work) {
        await this.tenants.reap(tenant);
      }
    } catch (error) {
      this.logger.error(
        `Reaper failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.reaping = false;
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async refillReserve(): Promise<void> {
    if (!this.config.enabled || this.refilling) return;
    if (!this.config.clusterId) {
      this.logger.warn('SANDBOX_CLUSTER_ID is not set — nothing is kept warm');
      return;
    }
    this.refilling = true;
    try {
      const first = await this.capacity.snapshot();
      if (first.target > first.warm) {
        this.logger.log(
          `Warm ${first.warm}, want ${first.target} (ceiling ${first.ceiling}). ${first.reason}`,
        );
      }

      // Re-asked before every build rather than computed once into a count.
      // A build takes two minutes, and in two minutes the answer can change:
      // somebody claims one, the reaper frees room, another process builds the
      // same thing. Asking again is one query and it is what keeps two API
      // replicas from each building the whole shortfall.
      for (let built = 0; built < MAX_BUILDS_PER_PASS; built++) {
        const missing = await this.capacity.missing();
        if (missing === 0) return;
        try {
          await this.tenants.provision(this.config.clusterId);
        } catch {
          // provision() already recorded why; stop the batch rather than hammer
          // a provider that is refusing us.
          return;
        }
      }
      this.logger.warn(
        `Stopped after ${MAX_BUILDS_PER_PASS} builds in one pass — demand is outrunning what one pass can build`,
      );
    } finally {
      this.refilling = false;
    }
  }

  /**
   * Keeps the images the guided path offers on the nodes.
   *
   * On a slow clock and outside the build path on purpose: a DaemonSet already
   * covers nodes that join later, and a guest waiting for an area must never be
   * waiting for a cache. Re-applied because the catalog can change under it.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async warmCatalogImages(): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.prepull.warmImages();
    } catch (error) {
      // A cold cache costs seconds; it never costs correctness.
      this.logger.warn(
        `Pre-pull could not be applied: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Rows whose teardown half-failed. FAILED is transient — the sweep picks it
   * up again next minute — so what is worth saying out loud once an hour is the
   * other one: the rows that gave the same answer often enough to be taken out
   * of the sweep, and are now waiting for a person.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async reportFailures(): Promise<void> {
    if (!this.config.enabled) return;
    const counts = await this.reserve.countByState();
    const parked = counts[SandboxTenantState.NEEDS_ATTENTION];
    if (parked > 0) {
      this.logger.warn(
        `${parked} sandbox tenancies stopped being retried and need a person: ` +
          'expire them with `flui sandbox expire <namespace>` once the reason is gone',
      );
    }
    if (counts[SandboxTenantState.FAILED] > 0) {
      this.logger.log(
        `${counts[SandboxTenantState.FAILED]} sandbox tenancies failed their last sweep and will be retried`,
      );
    }
  }
}
