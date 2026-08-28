import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScalingReconcilerService } from './scaling-reconciler.service';

/**
 * The loop that asks each group what it would do, once a minute.
 *
 * A minute because urgency's clock is seconds and a pod that cannot be placed
 * is already late; the group's own settle window, not this interval, is what
 * keeps a pod caught mid-schedule from counting as stuck.
 *
 * Running this changes nothing about what the product says of itself: what a
 * cluster tells a reader is derived from whether anything is registered to add
 * a node, and nothing here registers. The loop decides and writes; no machine
 * is created, resized or removed by any path leading out of it.
 */
@Injectable()
export class ScalingReconcilerScheduler {
  private readonly logger = new Logger(ScalingReconcilerScheduler.name);
  private running = false;

  constructor(private readonly reconciler: ScalingReconcilerService) {}

  @Cron(process.env.SCALING_RECONCILE_CRON || CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    // Reading a cluster's pending pods crosses the network once per group;
    // never let a slow tick overlap the next one.
    if (this.running) return;
    this.running = true;
    try {
      await this.reconciler.reconcileAll();
    } catch (err) {
      this.logger.error(
        `Scaling reconcile tick failed: ${(err as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }
}
