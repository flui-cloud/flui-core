import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IdentityConsoleService } from '../services/identity-console.service';

/** Closes an expired window and puts back a refusal that went missing; the first tick after a start closes an installation that never had one. */
@Injectable()
export class IdentityConsoleScheduler {
  private readonly logger = new Logger(IdentityConsoleScheduler.name);
  private running = false;

  constructor(private readonly console: IdentityConsoleService) {}

  @Cron(process.env.IDENTITY_CONSOLE_CRON || CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.console.reconcile();
    } catch (error) {
      this.logger.error(
        `Identity console reconcile failed: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }
}
