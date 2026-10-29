import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrimaryPlacementService } from '../services/primary-placement.service';

@Injectable()
export class PrimaryPlacementScheduler {
  private readonly logger = new Logger(PrimaryPlacementScheduler.name);
  private running = false;

  constructor(private readonly placement: PrimaryPlacementService) {}

  @Cron(
    process.env.FLUI_PRIMARY_PLACEMENT_CRON || CronExpression.EVERY_5_MINUTES,
  )
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.placement.sweep();
    } catch (err: any) {
      this.logger.error(
        `[postgres-ha] placement sweep failed: ${err?.message ?? err}`,
      );
    } finally {
      this.running = false;
    }
  }
}
