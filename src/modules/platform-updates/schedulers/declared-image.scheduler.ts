import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DeclaredImageService } from '../services/declared-image.service';

/**
 * The periodic check that the master declares what it runs.
 *
 * A reconciler is the only shape that reaches the API's own rollout, and it also
 * repairs an installation that drifted before any of this existed. Hourly: the
 * drift is harmless until the next k3s restart, and each pass runs a Job.
 */
@Injectable()
export class DeclaredImageScheduler {
  private readonly logger = new Logger(DeclaredImageScheduler.name);
  private running = false;

  constructor(private readonly declaredImages: DeclaredImageService) {}

  @Cron(process.env.DECLARED_IMAGE_CRON || CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const result of await this.declaredImages.reconcile()) {
        if (result.outcome === 'failed') {
          this.logger.warn(
            `${result.image} runs here but could not be declared: ${result.reason}`,
          );
        } else if (result.outcome === 'written') {
          this.logger.log(
            `Declared ${result.image} in ${result.files.join(', ')}; a restart now keeps this build.`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `[declared-image] cycle failed: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }
}
