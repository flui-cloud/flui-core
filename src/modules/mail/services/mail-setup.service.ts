import {
  Injectable,
  Logger,
  PreconditionFailedException,
} from '@nestjs/common';
import {
  observeRecords,
  verifyRecords,
  type MailDomainProofs,
  type MailDriver,
  type MailReadiness,
  type RequiredRecord,
  type SendScope,
} from '@flui-cloud/mail';
import { NodeDnsLookup } from '@flui-cloud/mail/node';
import { MailConnectionEntity } from '../entities/mail-connection.entity';
import { MailConnectionService } from './mail-connection.service';
import {
  IMPLICIT_SCALEWAY_ID,
  MailProviderResolver,
  implicitScaleway,
} from './mail-provider.resolver';
import type { MailTestTarget } from './mail-test.service';
import { MailCredentialsService } from './mail-credentials.service';
import { MailDnsWriterService } from './mail-dns-writer.service';

/** A sending domain, and the connection it belongs to. */
export interface MailDomainRow extends MailDomainProofs {
  provider: string;
  scope: SendScope;
  active: boolean;
  connectionId: string;
}

export interface MailConnectionSetup {
  domain: string | null;
  readiness: MailReadiness | null;
  /**
   * `live` is what the world resolves; `accepted` is what the provider says
   * about the same record. They disagree for as long as the provider has not
   * re-read DNS, and that gap is the whole answer to "who are we waiting for".
   */
  records: {
    name: string;
    kind: string;
    value: string;
    purpose: string;
    live?: boolean;
    accepted?: boolean;
  }[];
  verified: boolean;
  /** The provider accepts the domain is ours, which is not yet permission to send. */
  ownershipVerified?: boolean;
  /** Every record the provider asked for resolves publicly, right now. */
  published?: boolean;
  /**
   * Whether Flui holds the zone — the difference between a button and an
   * instruction.
   *
   * Handing someone a table of records to transcribe into a zone Flui is
   * already writing to is busywork dressed as guidance, and every hand-typed
   * record is a chance to publish one that looks right and resolves to nothing.
   */
  canWrite: boolean;
}

/**
 * Reading what is set up, as opposed to setting it up.
 *
 * Everything here is safe to call on a page load: it registers nothing, writes
 * nothing and stores nothing. That is the point of keeping it apart from the
 * connect path — the same questions are asked repeatedly while a domain waits
 * to verify, and a read that quietly created something at the provider would be
 * a surprising thing for looking at a screen to do.
 */
@Injectable()
export class MailSetupService {
  private readonly logger = new Logger(MailSetupService.name);

  constructor(
    private readonly connections: MailConnectionService,
    private readonly providers: MailProviderResolver,
    private readonly credentials: MailCredentialsService,
    private readonly dns: MailDnsWriterService,
  ) {}

  /**
   * The senders as they actually are, which is not the same as the rows stored.
   *
   * Scaleway Transactional Email rides on the compute key the user already
   * connected, so an install that has never configured anything here is still
   * sending — the resolver falls back to it. Listing only the table therefore
   * reports "nothing connected" about a provider that is at that moment
   * delivering password resets, which is the most misleading thing this screen
   * could say.
   *
   * The implicit row is marked as such rather than faked into a real one: it
   * has no stored credential of its own, no id to disconnect, and no sending
   * domain Flui has recorded — and every one of those differences matters to
   * whoever is reading.
   */
  async connectionsFor(): Promise<
    Array<MailConnectionEntity & { implicit?: boolean }>
  > {
    const stored = await this.connections.list();
    const hasExplicitTransactional = stored.some(
      (c) => c.scope === 'transactional' && c.isActive,
    );
    if (hasExplicitTransactional) return stored;

    // Only when Scaleway is connected to Flui at all. Otherwise the fallback
    // would fail on first use, and advertising a sender that cannot send is
    // worse than admitting there is none.
    if (!(await this.credentials.hasScalewayCredential())) return stored;

    return [{ ...implicitScaleway(), implicit: true }, ...stored];
  }

  /**
   * Every sending domain, across every connection, tagged with whose it is.
   *
   * A domain is not an attribute of the platform; it exists as one account's
   * registration and dies with that account, so the connection travels with
   * every row. Asking a single provider — whichever held transactional — would
   * hide a bulk provider's domain entirely and turn a driver with no
   * `domains()` of its own into an empty page rather than a partial one.
   *
   * A provider that cannot report drops out silently: it is one account failing
   * to answer, not a broken page, and an error here would hide the domains of
   * every provider that answered perfectly well.
   */
  async domainsAcrossConnections(): Promise<MailDomainRow[]> {
    const connections = await this.connectionsFor();
    const perConnection = await Promise.all(
      connections.map(async (connection): Promise<MailDomainRow[]> => {
        try {
          const driver = await this.providers.driverForConnection(connection);
          const reader = driver as {
            domains?: () => Promise<MailDomainProofs[]>;
          };
          if (typeof reader.domains !== 'function') return [];
          const proofs = await reader.domains();
          return proofs.map((proof) => ({
            ...proof,
            provider: connection.provider,
            scope: connection.scope,
            active: connection.isActive,
            connectionId: connection.id,
          }));
        } catch (error) {
          this.logger.debug(
            `[mail] ${connection.provider} (${connection.scope}) reported no domains: ` +
              `${(error as { message?: string })?.message ?? error}`,
          );
          return [];
        }
      }),
    );
    return perConnection.flat();
  }

  /**
   * Everything a test probe needs to go through *this* provider.
   *
   * Addressed by connection, not by domain: a provider on standby is put there
   * exactly so it can be proved before the password resets move onto it, and a
   * probe that always went through whichever connection holds transactional
   * would leave that standby untestable.
   */
  async testTargetFor(
    id: string,
  ): Promise<{ domain: string; target: MailTestTarget }> {
    const connection = await this.connectionOf(id);
    const driver = await this.providers.driverForConnection(connection);
    return {
      domain: await this.sendingDomainOf(connection, driver),
      target: {
        scope: connection.scope,
        driver,
        provider: connection.provider,
      },
    };
  }

  /**
   * What this provider still wants before it will send.
   *
   * The connect call already asks this once and then throws the answer away
   * with the result panel. That is the wrong lifetime for it: a domain is
   * authenticated minutes to hours after the records go in, so the state that
   * matters is the one *now*, and the page a person returns to had no way to
   * show it. Meanwhile the provider is refusing every message, which reads from
   * here as nothing happening at all.
   */
  async setupOf(id: string): Promise<MailConnectionSetup> {
    const connection = await this.connectionOf(id);
    const driver = await this.providers.driverForConnection(connection);
    const domain = connection.sendingDomain;

    const readiness = await this.readinessOf(driver, domain);
    if (!domain) {
      return {
        domain: null,
        readiness,
        records: [],
        verified: false,
        canWrite: false,
      };
    }

    // Whether this is ours to fix or theirs to copy. It decides the whole shape
    // of what gets shown: a zone Flui holds needs a button, not a table of
    // records to transcribe by hand into a zone Flui is already writing to.
    const canWrite = await this.dns.canWrite(domain).catch(() => false);

    // Read, never register: this runs on a page load, and a read that quietly
    // created a domain at the provider would be a surprising thing for looking
    // at a screen to do.
    try {
      const status = await driver.ensureDomain(domain);

      // Loud on purpose. A provider naming a record this codebase has no case
      // for looks exactly like a provider being slow, and two of the three
      // failures in this module so far were silent drops of precisely that
      // shape. If these counts ever disagree, that is the bug.
      const named = status.providerRecordKeys ?? [];
      if (named.length !== status.records.length) {
        this.logger.warn(
          `[mail] ${domain}: ${connection.provider} named ${named.length} record(s) ` +
            `(${named.join(', ')}) and ${status.records.length} were understood`,
        );
      }

      const live = await this.observed(status.records);
      return {
        domain,
        readiness,
        canWrite,
        verified: status.verified,
        ...(status.ownershipVerified === undefined
          ? {}
          : { ownershipVerified: status.ownershipVerified }),
        published: live.every,
        records: status.records.map((r) => ({
          name: r.name,
          kind: r.kind,
          value: r.value,
          purpose: r.purpose,
          // Three facts, not one. "In DNS", "the provider has read it" and
          // "the provider is satisfied" fail separately and are fixed in
          // separate places; collapsing them is what makes a published record
          // read as one nobody ever wrote.
          live: live.byName.has(`${r.kind}:${r.name.toLowerCase()}`),
          ...((r as { satisfied?: boolean }).satisfied === undefined
            ? {}
            : { accepted: (r as { satisfied?: boolean }).satisfied }),
        })),
      };
    } catch (error) {
      this.logger.debug(
        `[mail] could not read ${domain}: ${(error as Error).message}`,
      );
      return { domain, readiness, records: [], verified: false, canWrite };
    }
  }

  async readinessOf(
    driver: MailDriver,
    domain: string | null,
  ): Promise<MailReadiness | null> {
    if (typeof driver.readiness !== 'function') return null;
    try {
      return await driver.readiness(domain ?? undefined);
    } catch (error) {
      this.logger.debug(
        `[mail] readiness unavailable: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** The implicit sender has no row, so `byId` would refuse to find it. */
  async connectionOf(id: string): Promise<MailConnectionEntity> {
    return id === IMPLICIT_SCALEWAY_ID
      ? implicitScaleway()
      : this.connections.byId(id);
  }

  /**
   * What the public internet actually resolves for the records asked for.
   *
   * The whole point is to separate two things the provider's own answer folds
   * together. Brevo reports `status: false` on a record until *it* re-reads
   * DNS — which it does on its own schedule — so a record published minutes ago
   * and resolving perfectly still comes back looking unpublished. Reported as
   * "Flui can do this", it invites someone to publish what is already there and
   * then wonder why nothing changed, and it blames DNS propagation for a wait
   * that belongs entirely to the provider.
   *
   * Best-effort: a resolver that cannot answer means we do not know, which is
   * not the same as missing, so the record simply keeps the provider's verdict.
   */
  private async observed(
    records: readonly RequiredRecord[],
  ): Promise<{ byName: Set<string>; every: boolean }> {
    if (!records.length) return { byName: new Set(), every: false };
    try {
      // Public resolvers, not the machine's: the local one has just cached the
      // answer that the record does not exist, and will keep saying so for the
      // negative TTL — which reads exactly like a record that was never written.
      const lookup = new NodeDnsLookup({ servers: ['1.1.1.1', '8.8.8.8'] });
      const checks = verifyRecords(
        records,
        await observeRecords(lookup, records),
      );
      const byName = new Set(
        checks
          .filter((c) => c.verdict === 'ok')
          .map((c) => `${c.record.kind}:${c.record.name.toLowerCase()}`),
      );
      return { byName, every: byName.size === records.length };
    } catch (error) {
      this.logger.debug(
        `[mail] could not read DNS back: ${(error as Error).message}`,
      );
      return { byName: new Set(), every: false };
    }
  }

  /**
   * The domain to send the probe from.
   *
   * Falls back to what the provider says it has verified, because the sender
   * that most often has no domain recorded here is the implicit one — it was
   * never configured through Flui, so there is nothing in the row to read.
   */
  private async sendingDomainOf(
    connection: MailConnectionEntity,
    driver: MailDriver,
  ): Promise<string> {
    if (connection.sendingDomain) return connection.sendingDomain;

    const reader = driver as {
      domains?: () => Promise<Array<{ domain: string; verified: boolean }>>;
    };
    if (typeof reader.domains === 'function') {
      const verified = (await reader.domains()).find((d) => d.verified);
      if (verified) return verified.domain;
    }

    throw new PreconditionFailedException(
      `${connection.label} has no verified sending domain, so a test would have no address to ` +
        'come from. Set one up for it first.',
    );
  }
}
