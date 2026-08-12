import { Injectable } from '@nestjs/common';
import {
  BrevoDriver,
  ScalewayEventSource,
  ScalewayTemDriver,
  SmtpDriver,
  ZeptoMailDriver,
  type DeliveryEventSource,
  type MailDriver,
  type MailObservability,
  type ProviderCredentials,
  type SendScope,
} from '@flui-cloud/mail';
import { MailConnectionEntity } from '../entities/mail-connection.entity';
import { MailConnectionService } from './mail-connection.service';
import { MailCredentialsService } from './mail-credentials.service';
import { NodemailerTransport } from './nodemailer-transport';
import { MailNotConfiguredError } from '../utils/mail-error.util';

export interface ResolvedConnection {
  connection: MailConnectionEntity;
  driver: MailDriver;
}

/**
 * Which provider serves which purpose.
 *
 * Resolution is by **scope**, never globally, because the healthy configuration
 * is two providers at once: a transactional sender and, separately, a bulk one.
 * Anything that resolved "the mail provider" would make that arrangement
 * unrepresentable and would have to be unpicked later with a migration.
 *
 * Drivers are built per call and never cached. They hold no connection and no
 * state — each is a translation from a request to one HTTP call — so a cache
 * would buy nothing and would keep a revoked credential alive in memory.
 */
@Injectable()
export class MailProviderResolver {
  constructor(
    private readonly connections: MailConnectionService,
    private readonly scaleway: MailCredentialsService,
  ) {}

  /**
   * The sender for this scope.
   *
   * Falls back to Scaleway when nothing is configured at all, which keeps every
   * install that predates connections working exactly as before: the compute
   * key is already there and Transactional Email rides on it.
   */
  async driverFor(scope: SendScope): Promise<MailDriver> {
    return (await this.connectionFor(scope)).driver;
  }

  async connectionFor(scope: SendScope): Promise<ResolvedConnection> {
    const connection = await this.connections.active(scope);
    if (connection) {
      return { connection, driver: await this.build(connection) };
    }

    if (scope === 'bulk') {
      // Deliberately no fallback. The two transactional providers forbid bulk
      // in their terms, so quietly sending a mailing list through the
      // transactional sender is how an account gets suspended — taking the
      // password resets with it.
      throw new MailNotConfiguredError(
        'No bulk sender is configured. Connect a provider whose terms allow one-to-many ' +
          'mail, on its own account and its own sending domain.',
      );
    }

    return {
      connection: implicitScaleway(),
      driver: new ScalewayTemDriver(await this.scaleway.forScaleway()),
    };
  }

  /** What the sender for this scope can see. Drives how the console reports. */
  async observabilityFor(scope: SendScope): Promise<MailObservability> {
    return (await this.driverFor(scope)).observability;
  }

  /**
   * Every configured connection that has something to poll.
   *
   * A list rather than a lookup, and it may be empty: two of the four providers
   * push instead of polling and one reports nothing at all, so "no source" is a
   * normal state rather than an error the caller has to catch.
   */
  async eventSources(): Promise<
    Array<{ provider: string; source: DeliveryEventSource }>
  > {
    const connections = await this.connections.activeAll();
    const sources: Array<{ provider: string; source: DeliveryEventSource }> =
      [];

    for (const connection of connections.length
      ? connections
      : [implicitScaleway()]) {
      if (connection.provider !== 'scaleway-tem') continue;
      sources.push({
        provider: 'scaleway-tem',
        source: new ScalewayEventSource(await this.scaleway.forScaleway()),
      });
    }
    return sources;
  }

  /**
   * The driver for one specific connection, sending or not.
   *
   * Onboarding needs this: a provider stored without taking the scope still has
   * a domain to register and a webhook to point here, and resolving by scope
   * would quietly do all of that to whichever provider currently holds it.
   */
  driverForConnection(connection: MailConnectionEntity): Promise<MailDriver> {
    return this.build(connection);
  }

  private async build(connection: MailConnectionEntity): Promise<MailDriver> {
    switch (connection.provider) {
      case 'scaleway-tem':
        return new ScalewayTemDriver(await this.scaleway.forScaleway());

      case 'brevo':
        return new BrevoDriver(this.credentialsFor(connection, 'brevo'));

      case 'zeptomail':
        return new ZeptoMailDriver(
          this.credentialsFor(connection, 'zeptomail'),
        );

      case 'smtp': {
        const {
          host,
          port,
          username,
          secure,
          allowsBulk,
          spfInclude,
          dkimSelector,
          dkimValue,
        } = connection.config;
        if (!host) {
          throw new MailNotConfiguredError(
            'The SMTP connection has no relay host.',
          );
        }
        return new SmtpDriver(
          new NodemailerTransport({
            host,
            port: port ?? 587,
            ...(username ? { username } : {}),
            password: this.connections.secretOf(connection) ?? '',
            ...(secure === undefined ? {} : { secure }),
          }),
          {
            ...(spfInclude ? { spfInclude } : {}),
            ...(dkimSelector && dkimValue
              ? { dkim: { selector: dkimSelector, value: dkimValue } }
              : {}),
          },
          // Never deduced. The same code reaches a relay that welcomes
          // newsletters and one whose terms forbid them.
          { bulk: allowsBulk === true },
        );
      }

      default:
        throw new MailNotConfiguredError(
          `Unknown mail provider: ${connection.provider}`,
        );
    }
  }

  private credentialsFor(
    connection: MailConnectionEntity,
    provider: ProviderCredentials['provider'],
  ): ProviderCredentials {
    const token = this.connections.secretOf(connection);
    if (!token) {
      throw new MailNotConfiguredError(
        `The ${provider} connection has no credential stored.`,
      );
    }
    return {
      provider,
      token,
      ...(connection.config.region ? { region: connection.config.region } : {}),
    };
  }
}

/**
 * The connection an install has before anyone configures one.
 *
 * Not persisted: it exists so callers that expect a connection alongside a
 * driver get one, and so the Scaleway path keeps working untouched for every
 * install that already sends mail.
 */
/** Not a uuid on purpose: nothing should be able to mistake it for a stored row. */
export const IMPLICIT_SCALEWAY_ID = 'implicit-scaleway';

export function implicitScaleway(): MailConnectionEntity {
  const connection = new MailConnectionEntity();
  connection.id = IMPLICIT_SCALEWAY_ID;
  connection.provider = 'scaleway-tem';
  connection.scope = 'transactional';
  connection.label = 'Scaleway Transactional Email';
  connection.credentialSource = 'scaleway-compute';
  connection.sendingDomain = null;
  connection.encryptedSecret = null;
  connection.secretFingerprint = null;
  connection.encryptedWebhookSecret = null;
  connection.config = {};
  connection.isActive = true;
  return connection;
}
