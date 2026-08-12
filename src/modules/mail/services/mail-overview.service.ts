import { Injectable, Logger } from '@nestjs/common';
import {
  WINDOW_HOURS,
  buildOverview,
  type MailDomainProofs,
  type MailDriver,
  type MailOverview,
  type MailWindow,
  type SendScope,
} from '@flui-cloud/mail';
import { MailEventStoreService } from './mail-event-store.service';
import { MailPollService } from './mail-poll.service';
import { MailProviderResolver } from './mail-provider.resolver';

/**
 * What the console reads.
 *
 * The arithmetic is not here — it is in `@flui-cloud/mail`, as pure functions
 * over events and proofs. Two products render this screen, the Flui dashboard
 * and the standalone console shipped for vops, and a bounce rate computed twice
 * is a bounce rate that eventually disagrees with itself. This service gathers
 * the inputs and hands them over; it decides nothing about what they mean.
 */
@Injectable()
export class MailOverviewService {
  private readonly logger = new Logger(MailOverviewService.name);

  constructor(
    private readonly store: MailEventStoreService,
    private readonly providers: MailProviderResolver,
    private readonly poller: MailPollService,
  ) {}

  async overview(
    window: MailWindow = '14d',
    scope: SendScope = 'transactional',
  ): Promise<MailOverview> {
    const now = new Date();
    const spanMs = WINDOW_HOURS[window] * 60 * 60 * 1000;
    const from = new Date(now.getTime() - spanMs);
    const baselineFrom = new Date(from.getTime() - spanMs);

    // A host whose scheduler has never run would otherwise report a serene
    // empty console for a domain that has been sending for weeks.
    await this.poller.ensureBackfilled();

    const driver = await this.senderOr(scope);
    const [events, previous, domains] = await Promise.all([
      this.store.between(from, now),
      this.store.between(baselineFrom, from),
      this.domains(scope),
    ]);

    return buildOverview({
      window,
      now,
      events,
      previous,
      domains,
      ...(driver
        ? { provider: driver.id, observability: driver.observability }
        : {}),
    });
  }

  /**
   * Sending domains and what each record is worth.
   *
   * An empty list on failure rather than an error: email not being configured
   * is a normal state for a fresh platform, and answering the overview with a
   * 500 would hide every number on the page behind a problem that `/mail/
   * readiness` already explains in full.
   */
  async domains(
    scope: SendScope = 'transactional',
  ): Promise<MailDomainProofs[]> {
    try {
      const driver = await this.providers.driverFor(scope);
      const reader = driver as { domains?: () => Promise<MailDomainProofs[]> };
      // Not every provider will report per-record proofs, and one that cannot
      // is not a broken one — the Domains card simply has nothing to colour.
      return typeof reader.domains === 'function' ? await reader.domains() : [];
    } catch (error) {
      this.logger.debug(
        `[mail] no domain proofs available: ${(error as { message?: string })?.message ?? error}`,
      );
      return [];
    }
  }

  /**
   * The sender for this scope, or nothing.
   *
   * Nothing is a real answer: with no bulk provider connected the bulk overview
   * still has to render, and it renders as an empty window rather than as an
   * error. Falling back to the transactional sender's observability would
   * describe a provider that is not carrying this mail.
   */
  private async senderOr(scope: SendScope): Promise<MailDriver | null> {
    try {
      return await this.providers.driverFor(scope);
    } catch {
      return null;
    }
  }
}
