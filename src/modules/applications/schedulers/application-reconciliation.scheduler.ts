import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApplicationReconciliationService } from '../services/application-reconciliation.service';

/**
 * The periodic re-read of how every application is actually doing.
 *
 * Nothing else polls: the deploy processor observes once, right after
 * deploying, so `applications.status` was the outcome of the last deploy rather
 * than the health of anything — `running` said of a pod that died an hour
 * later, and `degraded` said of one that recovered.
 *
 * It observes and does not repair. `tryAutoHeal` returns unless an application
 * carries `driftPolicy: 'auto_heal'`, which nothing in this codebase writes.
 */
@Injectable()
export class ApplicationReconciliationScheduler {
  private readonly logger = new Logger(ApplicationReconciliationScheduler.name);
  private running = false;

  constructor(
    private readonly reconciliation: ApplicationReconciliationService,
  ) {}

  @Cron(process.env.APP_RECONCILE_CRON || CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    // One K8s read per resource per application, in sequence: a cluster with
    // many applications, or one reached over the network, can take longer than
    // a tick. Overlapping runs would double that load to learn the same thing.
    if (this.running) return;
    this.running = true;
    try {
      await this.reconciliation.reconcileAll();
    } catch (error) {
      this.logger.error(
        `[app-reconcile] cycle failed: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }
}
