import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DnsZoneReconciliationService } from '../services/dns-zone-reconciliation.service';

@Injectable()
export class DnsZoneReconciliationScheduler {
  private readonly logger = new Logger(DnsZoneReconciliationScheduler.name);
  private running = false;

  constructor(private readonly reconciliation: DnsZoneReconciliationService) {}

  @Cron(process.env.DNS_RECONCILE_CRON || CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    // Provider APIs can be slow — never let a slow run overlap the next tick.
    if (this.running) return;
    this.running = true;
    try {
      const zoneIds = await this.reconciliation.listReconcilableZoneIds();
      for (const zoneId of zoneIds) {
        try {
          await this.reconciliation.reconcileZone(zoneId);
        } catch (err: any) {
          this.logger.error(
            `[dns-reconcile] zone ${zoneId} failed: ${err?.message ?? err}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
