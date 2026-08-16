import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
import { SandboxReserveService } from './sandbox-reserve.service';
import { SandboxTenantService } from './sandbox-tenant.service';
import { SandboxTenantState } from '../entities/sandbox-tenant.entity';

/**
 * The two loops that keep the demo honest: one deletes what is past its
 * deadline, the other builds back what the reserve is missing.
 *
 * They never run concurrently with themselves. A reaper that overlaps its own
 * previous run would try to delete the same namespace twice and log a failure
 * for work that was actually fine; a builder that overlaps would overshoot the
 * reserve and pay for tenancies nobody asked for.
 */
@Injectable()
export class SandboxSchedulerService {
  private readonly logger = new Logger(SandboxSchedulerService.name);
  private reaping = false;
  private refilling = false;

  constructor(
    private readonly reserve: SandboxReserveService,
    private readonly tenants: SandboxTenantService,
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
      this.logger.warn('SANDBOX_CLUSTER_ID is not set — reserve stays empty');
      return;
    }
    this.refilling = true;
    try {
      const missing = await this.reserve.missingFromReserve();
      if (missing === 0) return;

      this.logger.log(`Building ${missing} tenancies to refill the reserve`);
      for (let i = 0; i < missing; i++) {
        try {
          await this.tenants.provision(this.config.clusterId);
        } catch {
          // provision() already recorded why; stop the batch rather than hammer
          // a provider that is refusing us.
          break;
        }
      }
    } finally {
      this.refilling = false;
    }
  }

  /** Rows whose teardown half-failed. Left visible instead of retried forever. */
  @Cron(CronExpression.EVERY_HOUR)
  async reportFailures(): Promise<void> {
    if (!this.config.enabled) return;
    const counts = await this.reserve.countByState();
    if (counts[SandboxTenantState.FAILED] > 0) {
      this.logger.warn(
        `${counts[SandboxTenantState.FAILED]} sandbox tenancies are in a failed state and need a look`,
      );
    }
  }
}
