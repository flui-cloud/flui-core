import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CrossProviderFirewallService } from '../services/cross-provider-firewall.service';

/**
 * Node public IPs change on rescale/recreation, so the cross-provider firewall
 * allow-rules must be re-derived on a loop, not written once. Same-provider
 * deployments make this a cheap no-op (no cross-provider pair → no rules).
 */
@Injectable()
export class FirewallReconciliationScheduler {
  private readonly logger = new Logger(FirewallReconciliationScheduler.name);
  private running = false;

  constructor(private readonly crossProvider: CrossProviderFirewallService) {}

  @Cron(process.env.FIREWALL_RECONCILE_CRON || CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    // Provider APIs / SSH pushes can be slow — never overlap the next tick.
    if (this.running) return;
    this.running = true;
    try {
      await this.crossProvider.reconcileAllPeers();
    } catch (err: any) {
      this.logger.error(`[fw-reconcile] tick failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
