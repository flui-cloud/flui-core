import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MailPollService } from '../services/mail-poll.service';
import { MailEventStoreService } from '../services/mail-event-store.service';

/**
 * Keeps delivery outcomes current, and keeps them no longer than agreed.
 *
 * Five minutes is chosen against what the data does, not against what a poller
 * can manage: a receiver answers in seconds to minutes, and a refusal that
 * arrives late is the one worth catching. Polling faster would mostly re-read
 * the same fortnight; polling slower would let an outage run unseen through
 * exactly the window someone would be looking at it.
 */
@Injectable()
export class MailPollScheduler {
  private readonly logger = new Logger(MailPollScheduler.name);
  private running = false;

  constructor(
    private readonly poller: MailPollService,
    private readonly store: MailEventStoreService,
  ) {}

  @Cron(process.env.MAIL_POLL_CRON || CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.poller.pollQuietly();
    } finally {
      this.running = false;
    }
  }

  /**
   * Separate from the poll on purpose: deleting other people's addresses must
   * keep happening on a host whose provider credentials have gone stale, and
   * folding it into the poll would tie retention to the provider being reachable.
   */
  @Cron(process.env.MAIL_PURGE_CRON || CronExpression.EVERY_DAY_AT_3AM)
  async purge(): Promise<void> {
    try {
      await this.store.purge();
    } catch (error) {
      this.logger.error(
        `[mail] retention sweep failed: ${(error as { message?: string })?.message ?? error}`,
      );
    }
  }
}
