import { Injectable, Logger } from '@nestjs/common';
import {
  MailRejectedError,
  screenRecipients,
  type DeliveryEvent,
  type MailDriver,
  type RequiredRecord,
  type SendRequest,
  type SendResult,
  type SendScope,
} from '@flui-cloud/mail';
import { MailSuppressionService } from './mail-suppression.service';
import { MailDnsWriterService } from './mail-dns-writer.service';
import { MailEventStoreService } from './mail-event-store.service';
import { MailPollService } from './mail-poll.service';
import { MailProviderResolver } from './mail-provider.resolver';
import {
  MailNotConfiguredError,
  describeError,
  toMailHttpError,
} from '../utils/mail-error.util';

/**
 * Handing a domain back is provider-specific and not every provider offers it.
 *
 * Structural rather than a check on the id: a driver written outside this
 * codebase can implement it, and `MailProviderId` is an open union precisely so
 * that stays possible.
 */
interface RevokesDomains {
  revokeDomain(
    domain: string,
  ): Promise<{ revoked: boolean; records: RequiredRecord[] }>;
}

function revokes(driver: MailDriver): driver is MailDriver & RevokesDomains {
  return typeof (driver as Partial<RevokesDomains>).revokeDomain === 'function';
}

/**
 * Sending, and finding out what became of it.
 *
 * The two are separate calls because delivery is separate in time: the provider
 * accepts a message in milliseconds and learns whether a receiver took it
 * seconds or minutes later. Anything that reports success at the moment of
 * sending is reporting that the request was well-formed, which is not the
 * question anybody is asking.
 */
@Injectable()
export class MailSendService {
  private readonly logger = new Logger(MailSendService.name);

  constructor(
    private readonly providers: MailProviderResolver,
    private readonly suppressions: MailSuppressionService,
    private readonly dnsWriter: MailDnsWriterService,
    private readonly poller: MailPollService,
    private readonly store: MailEventStoreService,
  ) {}

  /**
   * Register the domain with the provider and publish what it asks for.
   *
   * Idempotent end to end — `ensureDomain` is the call a wait-for-verification
   * loop makes repeatedly, and each record is upserted rather than added. Runs
   * whether or not Flui holds the zone: when it does not, the records come back
   * unpublished with `canWrite: false`, which is a list to copy rather than a
   * dead end.
   */
  async publishDomain(
    domain: string,
    scope: SendScope = 'transactional',
    /**
     * The provider to register with, when it is not the one holding the scope.
     * Onboarding passes it: a connection stored without taking over must set up
     * its own domain, not the sitting sender's.
     */
    using?: MailDriver,
  ): Promise<{
    domain: string;
    verified: boolean;
    canWrite: boolean;
    published: string[];
    outstanding: {
      name: string;
      kind: string;
      value: string;
      purpose: string;
    }[];
    error?: string;
    /** Whether the provider was asked to look again, and what it answered. */
    recheck?: RecheckOutcome;
  }> {
    try {
      const driver = using ?? (await this.providers.driverFor(scope));
      let status = await driver.ensureDomain(domain);
      const canWrite = await this.dnsWriter.canWrite(domain);

      const published: string[] = [];
      const failures: string[] = [];
      let recheck: RecheckOutcome | null = null;
      if (canWrite) await this.write(status.records, published, failures);

      // Having just published, ask the provider to re-read DNS now rather than
      // wait for its own schedule. Best-effort: a domain that is already checked
      // has nothing to recheck, and a refusal here must not undo a good publish.
      if (published.length && !status.verified) {
        recheck = await this.recheck(driver, domain, status.providerDomainId);

        // Then read again, because asking can change the answer. A provider may
        // withhold records until it believes the domain is yours — Brevo hands
        // over the DKIM key only once the ownership TXT checks out — so the
        // first publish is complete and still not enough. One more pass, not a
        // loop: without it the remedy is a second Publish that nobody is told
        // to press, and the domain sits half-configured looking finished.
        const reread = await driver.ensureDomain(domain).catch(() => status);
        if (canWrite) {
          const fresh = reread.records.filter(
            (r) => !published.includes(`${r.kind} ${r.name}`),
          );
          if (fresh.length) await this.write(fresh, published, failures);
        }
        status = reread;
      }

      return {
        domain,
        verified: status.verified,
        canWrite,
        published,
        outstanding: status.records
          .filter((r) => !published.includes(`${r.kind} ${r.name}`))
          .map((r) => ({
            name: r.name,
            kind: r.kind,
            value: r.value,
            purpose: r.purpose,
          })),
        ...(failures.length ? { error: failures.join('; ') } : {}),
        ...(recheck ? { recheck } : {}),
      };
    } catch (error) {
      throw toMailHttpError(error);
    }
  }

  /**
   * Write records into the zone, collecting what landed and what did not.
   *
   * One record failing must not abandon the rest: a domain with verification
   * and DKIM published and DMARC missing still authenticates, and whoever has
   * to fix it needs to know which one. The provider's own words are carried
   * through — an HTTP status with no body explains nothing.
   */
  private async write(
    records: readonly RequiredRecord[],
    published: string[],
    failures: string[],
  ): Promise<void> {
    for (const record of records) {
      try {
        await this.dnsWriter.upsert(record);
        published.push(`${record.kind} ${record.name}`);
      } catch (error) {
        failures.push(`${record.purpose}: ${describe(error)}`);
        this.logger.warn(
          `Could not publish ${record.kind} ${record.name}: ${error}`,
        );
      }
    }
  }

  /**
   * Who would carry a message of this kind right now.
   *
   * For the one place that has to name the provider without sending anything —
   * a probe refused before it dials, because the address is already suppressed.
   */
  async providerNameFor(scope: SendScope): Promise<string> {
    return (await this.providers.connectionFor(scope)).connection.provider;
  }

  /**
   * @param using the provider to send through, when it is not the one holding
   * the scope. Only the test probes pass it: a connection configured and not
   * yet sending is exactly the one worth proving before it takes over.
   */
  async send(req: SendRequest, using?: MailDriver): Promise<SendResult> {
    try {
      const deliverable = await this.screen(req);
      const driver =
        using ?? (await this.providers.driverFor(req.scope ?? 'transactional'));
      const result = await driver.send({ ...req, to: deliverable });
      this.logger.log(
        `Sent via ${result.provider}: messageId=${result.messageId ?? 'none'} accepted=${result.accepted}`,
      );

      // Some drivers already know the outcome. A relay settles every recipient
      // at handover and will never speak again, so these are not an optimistic
      // early record — they are the only record that will ever exist for that
      // message, and dropping them leaves the activity list and the do-not-send
      // list permanently empty for SMTP.
      if (result.events?.length) {
        await this.store.record(result.events);
        await this.suppressions.recordEvents(result.events);
      } else {
        await this.recordAcceptance(req, deliverable, result);
      }

      return result;
    } catch (error) {
      this.logger.warn(`Send refused: ${(error as Error).message}`);
      throw toMailHttpError(error);
    }
  }

  /**
   * Write down that the provider took the message, before it says anything else.
   *
   * Without this a message exists nowhere until its provider reports on it, and
   * the two providers that report by **webhook** may never report at all — an
   * unregistered webhook, a Flui with no public address, an event that gets
   * lost. The result was a console that showed nothing whatsoever for a send it
   * had just accepted: no row in Activity, no bar in the chart, nothing to
   * distinguish "sent and awaiting a verdict" from "never sent". That gap is
   * worse than a wrong verdict, because there is nothing to investigate.
   *
   * Recorded as `queued`, which is a fact of our own — the provider accepted it
   * — rather than a claim about delivery. Everything real supersedes it: the
   * store folds on provider + message id + recipient and refuses to move a
   * verdict backwards, so the poll or the webhook overwrites this row and never
   * duplicates it.
   *
   * Best-effort on purpose. The message is already gone; failing the send now
   * would report a failure for something that succeeded.
   */
  private async recordAcceptance(
    req: SendRequest,
    recipients: SendRequest['to'],
    result: SendResult,
  ): Promise<void> {
    // No id means no key, and a row that cannot be keyed can never be updated
    // by the verdict that follows — it would sit as `queued` for ever.
    if (!result.messageId) {
      this.logger.warn(
        `[mail] ${result.provider} returned no message id, so this send cannot be tracked`,
      );
      return;
    }

    const at = new Date().toISOString();
    const events: DeliveryEvent[] = recipients.map((to) => ({
      kind: 'queued',
      provider: result.provider,
      messageId: result.messageId!,
      recipient: to.email,
      from: req.from.email,
      subject: req.subject,
      at,
    }));

    try {
      await this.store.record(events);
    } catch (error) {
      this.logger.warn(
        `[mail] could not record the send: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Drop the addresses we already know not to write to.
   *
   * Split rather than refuse the whole message: one dead address among five is
   * no reason to withhold the other four. Only when *every* recipient is
   * suppressed is there nothing left to send, and that is reported as a
   * rejection carrying the reasons — a silent no-op here would look exactly
   * like a delivered message from the caller's side.
   */
  private async screen(req: SendRequest): Promise<SendRequest['to']> {
    const scope = req.scope ?? 'transactional';
    const held = await this.suppressions.suppressed(
      req.to.map((t) => t.email),
      scope,
    );
    if (!held.length) return req.to;

    const { deliverable, suppressed } = screenRecipients(req.to, held, scope);
    this.logger.log(
      `Held back ${suppressed.length} suppressed recipient(s) on a ${scope} send`,
    );
    if (!deliverable.length) {
      throw new MailRejectedError(
        `Every recipient is suppressed: ${suppressed
          .map((s) => `${s.address} (${s.reason})`)
          .join(', ')}.`,
        'scaleway-tem',
      );
    }
    return deliverable;
  }

  /**
   * Hand a sending domain back, and tidy up what can be tidied safely.
   *
   * Scaleway is blunt about the provider side: *"Deleting a domain is permanent
   * and cannot be undone"*, and the DKIM private key goes with it — so
   * registering the same domain later issues a new key under a new selector,
   * and any DKIM record still in the zone is dead weight.
   *
   * The DNS side is deliberately partial. `retract` removes the DKIM record and
   * takes the Flui `include:` back out of the SPF, then reports the MX and
   * DMARC as left in place, because nothing recorded whether we created them
   * and deleting an MX we did not create stops inbound mail with no error
   * anywhere. Half a cleanup that says which half is better than a whole one
   * that guesses.
   */
  async removeDomain(
    domain: string,
    options: { cleanupDns?: boolean; scope?: SendScope } = {},
  ): Promise<{
    domain: string;
    revoked: boolean;
    dns: {
      removed: string[];
      kept: { name: string; kind: string; reason: string }[];
    } | null;
  }> {
    try {
      const driver = await this.providers.driverFor(
        options.scope ?? 'transactional',
      );
      if (!revokes(driver)) {
        // Saying so beats a silent no-op that reports success: the operator
        // would believe the domain was handed back and find it still billed
        // and still sending.
        throw new MailNotConfiguredError(
          `${driver.id} does not remove domains over its API. Remove it in the provider's ` +
            'own console; the DNS records Flui published can then be cleaned up by hand.',
        );
      }
      const { revoked, records } = await driver.revokeDomain(
        domain.trim().toLowerCase(),
      );

      const cleanup =
        options.cleanupDns !== false &&
        records.length > 0 &&
        (await this.dnsWriter.canWrite(domain))
          ? await this.dnsWriter.retract(records)
          : null;

      this.logger.log(
        `[mail] ${revoked ? 'revoked' : 'no registration for'} ${domain}` +
          (cleanup ? `, removed ${cleanup.removed.length} DNS record(s)` : ''),
      );

      return { domain, revoked, dns: cleanup };
    } catch (error) {
      throw toMailHttpError(error);
    }
  }

  /**
   * Outcomes, read from what the poller has already collected.
   *
   * It used to call the provider on every request. That answered a single
   * question well and every other one badly: Scaleway pages a hundred emails at
   * a time and filters on creation date, so a fortnight took thousands of round
   * trips and a comparison against the fortnight before took twice that. The
   * provider is still the source of truth; the table is where the reading is
   * kept between polls.
   */
  async events(since?: Date): Promise<DeliveryEvent[]> {
    return this.poller.recent(since);
  }

  /**
   * Ask the provider to re-read DNS now rather than wait for its own schedule.
   *
   * Best-effort by design, and named per provider because they spell it
   * differently: Scaleway takes the domain id it issued, Brevo takes the domain
   * name. A refusal here must not undo a good publish — the records are live
   * either way and the provider will get to them.
   */
  /**
   * @returns what the provider said, or null when it was never asked.
   *
   * Returned rather than swallowed. This was the quietest call in the module:
   * a refusal and a success looked identical from outside, so "Flui asked the
   * provider to re-check" was a claim nothing could contradict — and while a
   * domain sits unverified for an hour, whether the request was even accepted
   * is the single most useful thing to know.
   */
  async recheck(
    driver: MailDriver,
    domain: string,
    providerDomainId: string | undefined,
  ): Promise<RecheckOutcome | null> {
    const scaleway = driver as {
      recheckDomain?: (id: string) => Promise<unknown>;
    };
    const brevo = driver as {
      authenticateDomain?: (
        domain: string,
      ) => Promise<{ accepted: boolean; detail?: string }>;
    };
    try {
      if (providerDomainId && typeof scaleway.recheckDomain === 'function') {
        await scaleway.recheckDomain(providerDomainId);
        return { asked: true, accepted: true };
      }
      if (typeof brevo.authenticateDomain === 'function') {
        const attempt = await brevo.authenticateDomain(domain);
        if (!attempt.accepted) {
          this.logger.warn(
            `[mail] ${domain} re-check refused: ${attempt.detail ?? 'no reason'}`,
          );
        }
        return { asked: true, ...attempt };
      }
      return null;
    } catch (error) {
      const detail = describe(error);
      this.logger.warn(`Recheck refused for ${domain}: ${detail}`);
      return { asked: true, accepted: false, detail };
    }
  }
}

/** Whether the provider was asked to look again, and what it answered. */
export interface RecheckOutcome {
  asked: boolean;
  accepted: boolean;
  detail?: string;
}

/** The provider's own words, when the HTTP client kept them. */
function describe(error: unknown): string {
  const err = error as {
    message?: string;
    response?: { data?: unknown; status?: number };
  };
  const body = err?.response?.data;
  if (body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return `${err.message ?? 'request failed'} — ${text.slice(0, 400)}`;
  }
  return err?.message ?? describeError(error);
}
