import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DemoOrchestratorService } from '../services/demo-orchestrator.service';

@Injectable()
export class DemoLoopScheduler {
  private readonly logger = new Logger(DemoLoopScheduler.name);
  private running = false;

  constructor(private readonly orchestrator: DemoOrchestratorService) {}

  @Cron(process.env.DEMO_LOOP_CRON || CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.orchestrator.tick();
    } catch (err: any) {
      this.logger.error(`[demo-loop] tick failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
