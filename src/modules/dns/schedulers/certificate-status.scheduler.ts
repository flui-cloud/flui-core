import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CertificateStatusRefreshService } from '../services/certificate-status-refresh.service';

@Injectable()
export class CertificateStatusScheduler {
  private readonly logger = new Logger(CertificateStatusScheduler.name);
  private running = false;

  @Cron(process.env.CERT_STATUS_REFRESH_CRON || CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const looked = await this.refresh.sweep();
      if (looked > 0) {
        this.logger.debug(
          `[cert-status] refreshed ${looked} issuing endpoint(s)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[cert-status] sweep failed: ${(err as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  constructor(private readonly refresh: CertificateStatusRefreshService) {}
}
