import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiServerFailoverService } from '../services/api-server-failover.service';

@Injectable()
export class ApiServerFailoverScheduler {
  private readonly logger = new Logger(ApiServerFailoverScheduler.name);
  private running = false;

  constructor(private readonly failover: ApiServerFailoverService) {}

  @Cron(
    process.env.FLUI_API_SERVER_FAILOVER_CRON || CronExpression.EVERY_MINUTE,
  )
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.failover.sweep();
    } catch (err: any) {
      this.logger.error(`[api-server] sweep failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
