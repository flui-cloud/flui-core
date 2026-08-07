import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertEventsService } from '../services/alert-events.service';

/**
 * Owns both halves of alert bookkeeping: closing rows whose resolve notification was
 * lost, and deleting history past its retention. One scheduler, two cheap queries.
 */
@Injectable()
export class AlertMaintenanceScheduler {
  private readonly logger = new Logger(AlertMaintenanceScheduler.name);
  private running = false;

  constructor(private readonly alertEvents: AlertEventsService) {}

  @Cron(process.env.ALERT_MAINTENANCE_CRON || CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.alertEvents.resolveStale();
      await this.alertEvents.purgeOld();
    } catch (err: any) {
      this.logger.error(
        `[alert-maintenance] tick failed: ${err?.message ?? err}`,
      );
    } finally {
      this.running = false;
    }
  }
}
