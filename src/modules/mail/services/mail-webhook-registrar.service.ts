import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailDriver } from '@flui-cloud/mail';
import { MailConnectionEntity } from '../entities/mail-connection.entity';
import { MailConnectionService } from './mail-connection.service';
import { MailProviderResolver } from './mail-provider.resolver';
import { describeError } from '../utils/mail-error.util';

export interface MailWebhookOutcome {
  registered: boolean;
  url?: string;
  reason?: string;
}

const API_PREFIX = '/api/v1';

/**
 * Telling a provider where to deliver its events.
 *
 * Every outcome is written to the row, failures included. A connection knows
 * whether it has a webhook by whether `webhookId` is set, but that says nothing
 * about *why* it does not, and a console left to guess the reason guesses the
 * most common one — which is how "the provider refused" ends up on screen as
 * "set a public URL".
 */
@Injectable()
export class MailWebhookRegistrarService {
  private readonly logger = new Logger(MailWebhookRegistrarService.name);

  constructor(
    private readonly connections: MailConnectionService,
    private readonly providers: MailProviderResolver,
    private readonly config: ConfigService,
  ) {}

  /**
   * Ask the provider again to deliver events here, for a connection already
   * stored.
   *
   * Its own entry point because the usual reason there is no webhook is a
   * missing public URL, and the fix for that is an environment variable — after
   * which the only route back was to paste the API key a second time. Nothing
   * about the credential changed, so nothing should have to be re-entered.
   */
  async retryWebhook(id: string): Promise<MailWebhookOutcome> {
    const connection = await this.connections.byId(id);
    // By connection, never by its scope: retrying a provider that is configured
    // but not sending would otherwise build the driver of whichever one holds
    // the scope, register that provider's webhook, and write its id onto this
    // row — leaving both connections describing something that is not true.
    const driver = await this.providers.driverForConnection(connection);
    return this.register(driver, connection);
  }

  /**
   * Point the provider's webhook at us, for the providers that can be told over
   * their API.
   *
   * Skipped, with a reason, when there is nowhere to point it: without a public
   * base URL the registration would succeed at the provider and deliver
   * nowhere, which is worse than not registering — it looks configured.
   */
  async register(
    driver: MailDriver,
    connection: MailConnectionEntity,
  ): Promise<MailWebhookOutcome> {
    if (driver.observability.channel !== 'webhook') {
      return {
        registered: false,
        reason: 'This provider does not push delivery events.',
      };
    }

    const base = this.publicBaseUrl();
    if (!base) {
      return this.failed(
        connection,
        undefined,
        `${connection.provider} reports what happened to a message by calling Flui back, and ` +
          'this instance has no public address for it to call. Set WEBHOOK_BASE_URL to the ' +
          'address this API answers on, then retry.',
      );
    }

    const url = `${base}/api/v1/webhooks/mail/${connection.provider}`;
    const registrar = driver as {
      ensureWebhook?: (
        url: string,
        token: string,
      ) => Promise<{ id: number; created: boolean }>;
    };
    if (typeof registrar.ensureWebhook !== 'function') {
      return this.failed(
        connection,
        url,
        `${driver.id} cannot be told where to send events over its API. Add ${url} as a webhook ` +
          'in its console.',
      );
    }

    const unreachable = await this.unreachable(url);
    if (unreachable) return this.failed(connection, url, unreachable);

    try {
      const secret = await this.connections.ensureWebhookSecret(connection);
      const { id, created } = await registrar.ensureWebhook(url, secret);
      await this.connections.setConfig(connection.id, {
        webhookId: String(id),
        webhookUrl: url,
        webhookNote: undefined,
      });
      if (created)
        this.logger.log(
          `[mail] registered a ${connection.provider} webhook at ${url}`,
        );
      return { registered: true, url };
    } catch (error) {
      return this.failed(
        connection,
        url,
        `${connection.provider} refused to register the webhook: ${readableProviderError(error)}`,
      );
    }
  }

  /**
   * Why the provider would not be able to reach `url`, or null if it can.
   *
   * Asked before registering rather than discovered later, because the failure
   * this prevents is silent: the provider accepts a dead URL, the console shows
   * a webhook, and no event ever arrives. Locally that is the normal state —
   * `WEBHOOK_BASE_URL` points at a tunnel, and a tunnel that is not running
   * still resolves and still looks like a valid address.
   *
   * A marker is required rather than a 2xx. A stopped tunnel, a proxy serving
   * its own warning page and another environment's API all answer politely and
   * none of them is us.
   */
  private async unreachable(url: string): Promise<string | null> {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json().catch(() => null)) as {
        flui?: string;
      } | null;
      if (res.ok && body?.flui === 'mail-webhook') return null;

      return (
        `${url} answers, but not as this Flui instance (HTTP ${res.status}) — the provider ` +
        'would post delivery events into nothing. If WEBHOOK_BASE_URL is a tunnel, it is most ' +
        'likely not running; otherwise check that the address really reaches this API.'
      );
    } catch (error) {
      const detail =
        (error as Error).name === 'TimeoutError'
          ? 'it did not answer in time'
          : (error as Error).message;
      return (
        `${url} cannot be reached from here — ${detail}. Running locally this usually means the ` +
        'tunnel named in WEBHOOK_BASE_URL is not up. Start it and try again.'
      );
    }
  }

  private async failed(
    connection: MailConnectionEntity,
    url: string | undefined,
    reason: string,
  ): Promise<MailWebhookOutcome> {
    // The id is cleared as well as the note written: leaving a stale one behind
    // would report a webhook that is registered while the reason it is not sits
    // beside it.
    await this.connections
      .setConfig(connection.id, {
        webhookId: undefined,
        webhookUrl: url,
        webhookNote: reason,
      })
      .catch(() => undefined);
    return { registered: false, ...(url ? { url } : {}), reason };
  }

  /**
   * Where a provider can reach this instance.
   *
   * `WEBHOOK_BASE_URL` first because it is the one that exists to answer this
   * question; the others are read as fallbacks so an install that set any of
   * them does not have to set a fourth.
   */
  private publicBaseUrl(): string | null {
    const candidates = [
      'WEBHOOK_BASE_URL',
      'PUBLIC_API_URL',
      'FLUI_API_ENDPOINT',
      'API_BASE_URL',
    ];
    for (const key of candidates) {
      const value = this.config.get<string>(key)?.trim();
      // A localhost URL is not reachable from a provider's network, and
      // registering it produces a webhook that silently never fires.
      if (
        value &&
        !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(value)
      ) {
        let base = value;
        while (base.endsWith('/')) base = base.slice(0, -1);
        return base.endsWith(API_PREFIX)
          ? base.slice(0, -API_PREFIX.length)
          : base;
      }
    }
    return null;
  }
}

/**
 * A provider's refusal, in a form a person can read.
 *
 * Provider errors carry the response body verbatim, which is the right default
 * — it is usually the only text that says why. It is also usually JSON, and
 * `{"code":"document_not_found","message":"Webhook record does not exist"}` on
 * a console is not an explanation, it is a thing to go and search for.
 */
function readableProviderError(error: unknown): string {
  const raw = describeError(error);
  // Kept, because it is the one part that says *where* the refusal happened: a
  // 404 is a route or a lookup, a 400 is the body we sent, a 403 is the key.
  // Dropping it leaves a sentence that reads the same for all three.
  const status = (error as { status?: number }).status;
  const suffix = status ? ` (HTTP ${status})` : '';

  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown };
    const message = parsed.message ?? parsed.error;
    if (typeof message === 'string' && message.trim())
      return `${message.trim()}${suffix}`;
  } catch {
    // Not JSON, which is the good case — it is already prose.
  }
  return `${raw}${suffix}`;
}
