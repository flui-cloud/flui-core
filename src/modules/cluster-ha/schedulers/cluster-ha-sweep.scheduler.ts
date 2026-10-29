import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClusterHaSweepService } from '../services/cluster-ha-sweep.service';

@Injectable()
export class ClusterHaSweepScheduler {
  private readonly logger = new Logger(ClusterHaSweepScheduler.name);
  private running = false;

  constructor(private readonly sweeper: ClusterHaSweepService) {}

  @Cron(
    process.env.FLUI_CLUSTER_HA_SWEEP_CRON || CronExpression.EVERY_10_MINUTES,
  )
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sweeper.sweep();
    } catch (err: any) {
      this.logger.error(`[ha] sweep failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
