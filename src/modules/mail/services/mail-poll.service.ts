import { Injectable, Logger } from '@nestjs/common';
import type { DeliveryEvent } from '@flui-cloud/mail';
import { MailSuppressionService } from './mail-suppression.service';
import { MailEventStoreService } from './mail-event-store.service';
import { MailProviderResolver } from './mail-provider.resolver';
import { describeError, toMailHttpError } from '../utils/mail-error.util';

/**
 * The one place that asks providers about outcomes.
 *
 * Only some of them can be asked. Scaleway's webhook resource takes an SNS topic
 * ARN rather than a URL, so receiving pushes from it means standing up a topic
 * and a confirmed subscription on a second product; `GET /emails` returns the
 * same verdicts for the price of a poll interval and needs no public address at
 * all. Brevo and ZeptoMail push instead, and arrive through the webhook
 * controller. A relay says nothing after the handover.
 *
 * So this iterates whatever *can* be polled and is content to find nothing:
 * an install with no pollable provider is configured, not broken.
 */
@Injectable()
export class MailPollService {
  private readonly logger = new Logger(MailPollService.name);

  /**
   * Per provider, not global — both of these.
   *
   * A shared flag is a bug the moment a second connection exists: one healthy
   * provider would mark the backfill done and mask a second that has never been
   * read, and one broken provider's warning would suppress the first failure of
   * the other.
   */
  private readonly backfilled = new Set<string>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly providers: MailProviderResolver,
    private readonly suppressions: MailSuppressionService,
    private readonly store: MailEventStoreService,
  ) {}

  /**
   * Read every pollable provider forward from what we already hold for *it*.
   *
   * The cursor is per provider. Shared, it loses data: a busy provider drags
   * the mark forward and the quiet one's next poll starts after events it never
   * read. The source then reaches back a day beyond that mark on its own,
   * because Scaleway filters on *creation* date — a message sent this morning
   * that bounces this afternoon is still a message created this morning. The
   * re-read is free, since the store upserts and refuses to move a verdict
   * backwards.
   */
  async poll(): Promise<{ read: number; stored: number }> {
    const sources = await this.providers.eventSources();
    let read = 0;
    let stored = 0;

    for (const { provider, source } of sources) {
      // One provider failing must not stop the others: they are independent
      // accounts, and a revoked key on the bulk sender is no reason to stop
      // collecting bounces on the transactional one.
      try {
        const since = await this.store.newestAt(provider);
        const events = await source.poll(since ?? undefined);
        this.backfilled.add(provider);
        this.warned.delete(provider);

        stored += await this.store.record(events);
        // Polling is the only moment a platform learns an address is dead for
        // this provider, so the fold happens here rather than in a job that
        // could drift behind it.
        await this.suppressions.recordEvents(events);
        read += events.length;
      } catch (error) {
        this.report(provider, error);
      }
    }

    return { read, stored };
  }

  /**
   * What the console and the CLI read. The store, not the provider.
   *
   * One exception: an empty store on a host whose scheduler has never run would
   * report "no mail" for a domain that has been sending for weeks. So the first
   * ask backfills, and only the first.
   */
  async recent(since?: Date): Promise<DeliveryEvent[]> {
    await this.ensureBackfilled();
    const from = since ?? new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    return this.store.between(from, new Date());
  }

  /**
   * Fill the table if it has never been filled, and do nothing thereafter.
   *
   * Separate from `recent` so a caller about to run its own queries — the
   * overview does three — does not pay for a read it is going to discard.
   */
  async ensureBackfilled(): Promise<void> {
    const sources = await this.providers.eventSources();
    const missing = sources.filter((s) => !this.backfilled.has(s.provider));
    if (missing.length === 0) return;

    for (const { provider } of missing) {
      if ((await this.store.newestAt(provider)) !== null)
        this.backfilled.add(provider);
    }
    if (sources.every((s) => this.backfilled.has(s.provider))) return;

    await this.poll();
    // Whatever is still unread failed, and `report` has already said so once.
    // Marking them stops a backfill attempt on every subsequent request.
    for (const { provider } of sources) this.backfilled.add(provider);
  }

  /**
   * The scheduler's entry point: same poll, but a provider that is not set up
   * is a state to note once rather than an error to raise every tick.
   */
  async pollQuietly(): Promise<void> {
    try {
      const { read, stored } = await this.poll();
      if (read > 0) {
        this.logger.log(
          `[mail] polled ${read} delivery outcomes, ${stored} written`,
        );
      }
    } catch (error) {
      this.report('mail', error);
    }
  }

  private report(provider: string, error: unknown): void {
    const wrapped = toMailHttpError(error);
    const message =
      (wrapped as { message?: string })?.message ?? describeError(error);
    if (this.warned.has(provider)) {
      this.logger.debug(`[mail] ${provider} poll skipped: ${message}`);
      return;
    }
    this.warned.add(provider);
    this.logger.warn(
      `[mail] delivery polling for ${provider} is not running: ${message}. ` +
        'Further failures log at debug until it recovers.',
    );
  }
}
