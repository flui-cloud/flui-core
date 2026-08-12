import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import {
  ZEPTOMAIL_SIGNATURE_HEADER,
  bearerToken,
  brevoEvents,
  secretsMatch,
  verifyZeptoMailSignature,
  zeptoMailEvents,
} from '@flui-cloud/mail';
import { MailConnectionEntity } from '../entities/mail-connection.entity';
import { MailConnectionService } from './mail-connection.service';
import { MailEventStoreService } from './mail-event-store.service';
import { MailSuppressionService } from './mail-suppression.service';

export type WebhookProvider = 'brevo' | 'zeptomail';

export interface WebhookResult {
  received: number;
  stored: number;
}

/**
 * Delivery outcomes that arrive by being pushed.
 *
 * This endpoint writes into the suppression list, which makes it the most
 * security-sensitive surface the mail module has: anyone who can post here can
 * stop an operator emailing whoever they choose, and a suppressed address is
 * indistinguishable from one that was never written to. So an unverified call
 * is refused before anything is parsed, and the two providers are verified by
 * completely different means because that is what each offers.
 */
@Injectable()
export class MailWebhookService {
  private readonly logger = new Logger(MailWebhookService.name);

  constructor(
    private readonly connections: MailConnectionService,
    private readonly store: MailEventStoreService,
    private readonly suppressions: MailSuppressionService,
  ) {}

  async handle(
    provider: WebhookProvider,
    headers: Record<string, string | undefined>,
    rawBody: string,
    body: unknown,
  ): Promise<WebhookResult> {
    const connection = await this.authenticate(provider, headers, rawBody);

    const events =
      provider === 'brevo' ? brevoEvents(body) : zeptoMailEvents(body);
    if (events.length === 0) return { received: 0, stored: 0 };

    // Taken as they came. Brevo's payload carries no sender, and the mapper
    // recovers it from the header the driver sent it out with — but mail put
    // through the same account by something other than Flui arrives without
    // one, and filling that in from the connection's own domain would be a
    // guess. An event with no sender shows ungrouped, which is the truth about
    // a message this platform did not send.
    this.logger.debug(
      `[mail] ${events.length} events from ${connection.label}`,
    );

    const stored = await this.store.record(events);
    // The same fold the poller performs, from the same events, so an address
    // dies in exactly one way no matter which provider reported it.
    await this.suppressions.recordEvents(events);

    return { received: events.length, stored };
  }

  /**
   * Which connection sent this, proven rather than assumed.
   *
   * Iterating the connections for a provider rather than taking the first is
   * what makes the secret meaningful: each one holds a different token, so
   * matching identifies the sender as a side effect of authenticating it.
   * Nothing matching is a 401 with no detail — telling a caller *why* their
   * token failed is telling them how to fix it.
   */
  private async authenticate(
    provider: WebhookProvider,
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): Promise<MailConnectionEntity> {
    const candidates = (await this.connections.activeAll()).filter(
      (c) => c.provider === provider,
    );

    for (const candidate of candidates) {
      const secret = this.connections.webhookSecretOf(candidate);
      if (!secret) continue;

      if (provider === 'brevo') {
        // Brevo publishes no signature scheme at all — the mechanism it does
        // offer is a token it hands back, so that is what is compared.
        if (secretsMatch(bearerToken(headers), secret)) return candidate;
        continue;
      }

      const verdict = await verifyZeptoMailSignature(
        headers[ZEPTOMAIL_SIGNATURE_HEADER],
        rawBody,
        secret,
      );
      if (verdict.valid) return candidate;
      if (verdict.reason) {
        this.logger.debug(
          `[mail] ${provider} webhook rejected: ${verdict.reason}`,
        );
      }
    }

    this.logger.warn(
      `[mail] refused an unauthenticated ${provider} webhook call`,
    );
    throw new UnauthorizedException();
  }
}
