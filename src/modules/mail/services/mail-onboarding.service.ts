import {
  BadRequestException,
  Injectable,
  Logger,
  PreconditionFailedException,
} from '@nestjs/common';
import type { MailDriver, MailReadiness } from '@flui-cloud/mail';
import { MailConnectionEntity } from '../entities/mail-connection.entity';
import {
  MailConnectionService,
  type CreateMailConnection,
} from './mail-connection.service';
import { MailProviderResolver } from './mail-provider.resolver';
import { MailSendService } from './mail-send.service';
import { MailSetupService } from './mail-setup.service';
import {
  MailWebhookRegistrarService,
  type MailWebhookOutcome,
} from './mail-webhook-registrar.service';

export interface ConnectResult {
  connection: {
    id: string;
    provider: string;
    scope: string;
    label: string;
    sendingDomain: string | null;
  };
  /**
   * Whether this connection is now the one sending.
   *
   * Reported rather than assumed: a scope that already had a sender keeps it,
   * so "connected" and "sending" are two different pieces of news and a screen
   * that conflated them would announce a takeover that did not happen.
   */
  activated: boolean;
  /** What the provider can see once connected. Drives how the console reports. */
  observability: MailDriver['observability'];
  domain: {
    published: string[];
    outstanding: {
      name: string;
      kind: string;
      value: string;
      purpose: string;
    }[];
    canWrite: boolean;
    verified: boolean;
    error?: string;
    /** Whether the provider was asked to look again, and what it answered. */
    recheck?: { asked: boolean; accepted: boolean; detail?: string };
  } | null;
  webhook: MailWebhookOutcome;
  readiness: MailReadiness | null;
  /** Everything a person still has to do themselves, in order. */
  manualSteps: string[];
}

/**
 * Connecting a provider, in one call.
 *
 * The goal is that pasting a key is the whole job: Flui registers the domain,
 * writes the DNS records itself, asks the provider to verify, and registers the
 * webhook — none of which should send anyone to a provider's console.
 *
 * It is an **idempotent method behind one POST**, not a saga. Everything it
 * does converges: `ensureDomain` is the call a wait-for-verification loop makes
 * repeatedly, every DNS write is an upsert, and `ensureWebhook` looks before it
 * creates. So the retry story is "call it again", and the only genuinely
 * long-running part — waiting for DNS to propagate and the provider to believe
 * it — is a poll of `readiness`, which the client already knows how to do.
 *
 * Nothing here fails the whole connect because one step could not be automated.
 * A zone Flui does not hold, an MX already in place, a provider that verifies
 * domains only in its own console: each becomes a line in `manualSteps` while
 * the connection is still stored. Refusing to save a working credential because
 * a DMARC record could not be written would be the wrong trade every time.
 */
@Injectable()
export class MailOnboardingService {
  private readonly logger = new Logger(MailOnboardingService.name);

  constructor(
    private readonly connections: MailConnectionService,
    private readonly providers: MailProviderResolver,
    private readonly sender: MailSendService,
    private readonly setup: MailSetupService,
    private readonly webhooks: MailWebhookRegistrarService,
  ) {}

  async connect(input: CreateMailConnection): Promise<ConnectResult> {
    await this.assertDomainNotAlreadySending(input);
    const connection = await this.connections.upsert(input);
    // Built from the row rather than from the scope: a connection stored
    // without taking the slot must still have its domain registered and its
    // webhook set up, and resolving by scope would set up the other one.
    const driver = await this.providers.driverForConnection(connection);

    const domain = connection.sendingDomain
      ? await this.publish(connection.sendingDomain, connection, driver)
      : null;

    const webhook = await this.webhooks.register(driver, connection);
    const readiness = await this.setup.readinessOf(
      driver,
      connection.sendingDomain,
    );

    return {
      connection: {
        id: connection.id,
        provider: connection.provider,
        scope: connection.scope,
        label: connection.label,
        sendingDomain: connection.sendingDomain,
      },
      activated: connection.isActive,
      observability: driver.observability,
      domain,
      webhook,
      readiness,
      manualSteps: manualSteps({
        connection,
        domain,
        webhook,
        readiness,
        pushes: driver.observability.channel === 'webhook',
      }),
    };
  }

  /**
   * Refuse a domain the *other* scope is already sending from, even when Flui
   * never recorded that it was.
   *
   * `MailConnectionService` compares against the other scope's stored domain,
   * which closes the case where both were configured here. It cannot close the
   * one that actually happens first: Scaleway sends on the compute key with no
   * row at all, so there is no stored domain to compare against and the check
   * silently passes — letting a mailing list be pointed at the same domain the
   * password resets go out from, which is the single arrangement this whole
   * separation exists to prevent.
   *
   * So the other scope's provider is asked what it actually holds. A failure to
   * ask is not a failure to connect: an unreachable provider must not block a
   * configuration change, and the stored-domain check still stands behind this.
   */
  private async assertDomainNotAlreadySending(
    input: CreateMailConnection,
  ): Promise<void> {
    const domain = input.sendingDomain?.trim().toLowerCase();
    if (!domain) return;

    const otherScope = input.scope === 'bulk' ? 'transactional' : 'bulk';
    let held: string[];
    try {
      const driver = await this.providers.driverFor(otherScope);
      const reader = driver as {
        domains?: () => Promise<Array<{ domain: string }>>;
      };
      if (typeof reader.domains !== 'function') return;
      held = (await reader.domains()).map((d) => d.domain.toLowerCase());
    } catch {
      return;
    }

    if (held.includes(domain)) {
      throw new BadRequestException(
        `${domain} is already sending ${otherScope} mail through the other provider. Use a ` +
          `separate domain — a subdomain is enough, and reputation is tracked per domain, so ` +
          `sharing one lets a problem with ${input.scope} mail damage the other.`,
      );
    }
  }

  /**
   * Register the domain and publish what the provider asks for.
   *
   * Delegates rather than reimplements: `publishDomain` already handles a zone
   * Flui does not hold, per-record failure tolerance and the provider recheck.
   * Its failures are returned, not raised — see the class note.
   */
  private async publish(
    domain: string,
    connection: MailConnectionEntity,
    driver: MailDriver,
  ): Promise<ConnectResult['domain']> {
    try {
      const result = await this.sender.publishDomain(
        domain,
        connection.scope,
        driver,
      );
      return {
        published: result.published,
        outstanding: result.outstanding,
        canWrite: result.canWrite,
        verified: result.verified,
        ...(result.error ? { error: result.error } : {}),
        ...(result.recheck ? { recheck: result.recheck } : {}),
      };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`[mail] could not set up ${domain}: ${message}`);
      return {
        published: [],
        outstanding: [],
        canWrite: false,
        verified: false,
        error: message,
      };
    }
  }

  /**
   * Register a domain with this connection's provider and publish its records.
   *
   * `domain` names one explicitly; without it the connection's own sending
   * domain is used, which is what the setup panel re-runs. One account may send
   * from several domains, and a second one registered here is registered
   * against a chosen account rather than against whichever provider happens to
   * hold transactional — the ambiguity that made this action unreadable when it
   * lived on a page with no account in sight.
   *
   * Offered as its own action because the first attempt can be wrong in ways
   * only time reveals, and re-publishing is an upsert: the remedy for "it never
   * verified" should be one button rather than a disconnect and a re-onboarding.
   *
   * The connection's recorded sending domain is deliberately left alone: adding
   * a domain to an account is not a decision to move the mail onto it.
   */
  async publishFor(
    id: string,
    domain?: string,
  ): Promise<ConnectResult['domain']> {
    const connection = await this.setup.connectionOf(id);
    const target = domain?.trim().toLowerCase() || connection.sendingDomain;
    if (!target) {
      throw new PreconditionFailedException(
        `${connection.label} has no sending domain, so there is nothing to publish.`,
      );
    }
    const driver = await this.providers.driverForConnection(connection);
    return this.publish(target, connection, driver);
  }

  /**
   * Hand the scope to a connection already stored.
   *
   * Deliberately not folded into `connect`: switching which provider carries
   * password resets is a decision of its own, and it should not be something
   * that happens as a side effect of pasting a key.
   */
  async activate(id: string): Promise<MailConnectionEntity> {
    return this.connections.activate(id);
  }

  async disconnect(id: string): Promise<void> {
    const connection = await this.connections.byId(id);
    // One last poll before the credential goes: a message sent a minute ago
    // bounces in a few more, and destroying the key now means that verdict is
    // never collected and the dead address never suppressed.
    if (connection.provider === 'scaleway-tem') {
      try {
        await this.sender.events();
      } catch (error) {
        this.logger.debug(
          `[mail] final poll skipped: ${(error as Error).message}`,
        );
      }
    }
    await this.connections.remove(id);
  }
}

/**
 * What is left for a person, phrased as instructions rather than as errors.
 *
 * Ordered by what blocks what: a credential that does not work makes every
 * other line noise, and records that are not published make "waiting for
 * verification" misleading.
 */
function manualSteps(input: {
  connection: MailConnectionEntity;
  domain: ConnectResult['domain'];
  webhook: MailWebhookOutcome;
  readiness: MailReadiness | null;
  /** Whether outcomes for this provider arrive by webhook at all. */
  pushes: boolean;
}): string[] {
  const steps: string[] = [];

  for (const step of input.readiness?.steps ?? []) {
    if (step.status === 'manual' && step.action) steps.push(step.action);
  }

  if (
    input.domain &&
    !input.domain.canWrite &&
    input.domain.outstanding.length
  ) {
    steps.push(
      `Flui does not hold the DNS zone for ${input.connection.sendingDomain}. Publish the ` +
        `${input.domain.outstanding.length} record(s) listed above wherever it is hosted.`,
    );
  }
  if (input.domain?.error) {
    steps.push(input.domain.error);
  }
  // Only for a provider that pushes: "this one does not send events" is a fact
  // about the provider, and listing it as something left to do would ask for
  // work that does not exist.
  if (input.pushes && !input.webhook.registered && input.webhook.reason) {
    steps.push(input.webhook.reason);
  }

  return steps;
}
