import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KubeconfigEndpointPromoter } from '../services/kubeconfig-endpoint.promoter';

/**
 * Its own loop, and its own flag, because it repairs a correctness problem
 * rather than serving a feature: hanging it off the telemetry sweep would make
 * a cluster's API address depend on whether telemetry happens to be switched
 * on.
 */
@Injectable()
export class KubeconfigEndpointScheduler {
  private readonly logger = new Logger(KubeconfigEndpointScheduler.name);
  private running = false;

  constructor(private readonly promoter: KubeconfigEndpointPromoter) {}

  @Cron(
    process.env.FLUI_KUBECONFIG_PROMOTE_CRON || CronExpression.EVERY_10_MINUTES,
  )
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const moved = await this.promoter.promoteAll();
      if (moved > 0) {
        this.logger.log(
          `[kubeconfig] ${moved} cluster(s) now addressed over the overlay`,
        );
      }
    } catch (err: any) {
      this.logger.error(`[kubeconfig] tick failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
