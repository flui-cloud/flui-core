import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  findSpf,
  hasSpfInclude,
  mergeSpfInclude,
  removeSpfInclude,
  type DnsRetraction,
  type DnsWriter,
  type RequiredRecord,
} from '@flui-cloud/mail';
import { DnsZoneEntity } from '../../dns/entities/dns-zone.entity';
import { DnsProviderFactory } from '../../providers/core/factories/dns-provider.factory';
import {
  DnsRecordType,
  type IDnsProvider,
} from '../../providers/interfaces/dns-provider.interface';

/**
 * Publishing the records a mail provider asks for, into a zone Flui holds.
 *
 * This removes the step people most reliably get wrong — copying three long
 * records by hand — but only for domains whose zone is managed here. A domain
 * kept elsewhere degrades to "here are the records, go and add them", which is
 * why `canWrite` exists and why nothing above assumes it returns true.
 *
 * Scaleway's own autoconfiguration already covers domains on Scaleway DNS, so
 * this is what makes the capability usable for everyone else.
 */
@Injectable()
export class MailDnsWriterService implements DnsWriter {
  private readonly logger = new Logger(MailDnsWriterService.name);

  constructor(
    @InjectRepository(DnsZoneEntity)
    private readonly zones: Repository<DnsZoneEntity>,
    private readonly dnsProviders: DnsProviderFactory,
  ) {}

  async canWrite(domain: string): Promise<boolean> {
    return (await this.resolveZone(domain)) !== null;
  }

  async upsert(record: RequiredRecord): Promise<void> {
    const resolved = await this.resolveZone(record.name);
    if (!resolved) {
      throw new Error(
        `No managed DNS zone covers ${record.name}. Publish this record wherever the ` +
          `domain's zone actually lives.`,
      );
    }
    const { zone, provider } = resolved;
    const name = relativeName(record.name, zone.zoneName);
    const type = typeOf(record);

    if (record.purpose === 'spf') {
      await this.upsertSpf(provider, zone, name, record.name, record.value);
      return;
    }

    if (type === DnsRecordType.MX) {
      await this.upsertMx(provider, zone, name, record);
      return;
    }

    const existing = (await provider.listRecords(zone.providerZoneId)).filter(
      (r) => r.type === type && matchesName(r.name, name, record.name),
    );

    // Idempotent: this is called in a wait-for-verification loop.
    if (existing.some((r) => sameValue(record, r.value))) return;

    if (existing.length) {
      const target = existing[0]!;
      await provider.updateRecord({
        recordId: target.recordId,
        zoneId: zone.providerZoneId,
        type,
        name,
        value: valueFor(record),
      });
      this.logger.log(`Updated ${type} ${record.name} in ${zone.zoneName}`);
      return;
    }

    await provider.createRecord({
      zoneId: zone.providerZoneId,
      type,
      name,
      value: valueFor(record),
    });
    this.logger.log(`Created ${type} ${record.name} in ${zone.zoneName}`);
  }

  /**
   * Undo the publish, for a domain being handed back to the operator.
   *
   * Deliberately not the mirror image of `upsert`. Two of the four records were
   * never unambiguously ours: the SPF was *merged into* whatever the domain
   * already published, and the MX and DMARC may have predated us entirely —
   * `upsertMx` refuses to overwrite an existing MX precisely because it cannot
   * tell. Nothing records which of them we created, and guessing wrong on the
   * way out is worse than on the way in: deleting an MX kills a working inbox,
   * and deleting an SPF deauthorises every other sender the domain has.
   *
   * So: DKIM is deleted, because the selector is ours and worthless the moment
   * the provider destroys the key. SPF has our `include:` taken back out and
   * the rest left standing. MX and DMARC are reported, not touched.
   */
  async retract(records: readonly RequiredRecord[]): Promise<DnsRetraction> {
    const removed: string[] = [];
    const kept: DnsRetraction['kept'] = [];

    for (const record of records) {
      const resolved = await this.resolveZone(record.name);
      if (!resolved) {
        kept.push({
          name: record.name,
          kind: record.kind,
          reason:
            'Flui does not hold this zone — remove it wherever the zone lives.',
        });
        continue;
      }

      try {
        const done = await this.retractOne(resolved, record);
        if (done) removed.push(`${record.kind} ${record.name}`);
        else {
          kept.push({
            name: record.name,
            kind: record.kind,
            reason: reasonForKeeping(record),
          });
        }
      } catch (error) {
        kept.push({
          name: record.name,
          kind: record.kind,
          reason: `Could not be removed: ${(error as Error).message}`,
        });
      }
    }

    return { removed, kept };
  }

  private async retractOne(
    resolved: { zone: DnsZoneEntity; provider: IDnsProvider },
    record: RequiredRecord,
  ): Promise<boolean> {
    const { zone, provider } = resolved;
    const name = relativeName(record.name, zone.zoneName);
    const type = typeOf(record);

    // Left in place on purpose — see `retract`.
    if (record.purpose === 'mx' || record.purpose === 'dmarc') return false;

    const existing = (await provider.listRecords(zone.providerZoneId)).filter(
      (r) => r.type === type && matchesName(r.name, name, record.name),
    );

    if (record.purpose === 'spf') {
      const current = existing.find((r) =>
        unquote(r.value).toLowerCase().startsWith('v=spf1'),
      );
      if (!current) return false;
      const rewritten = removeSpfInclude(
        unquote(current.value),
        includeTarget(record.value) ?? '',
      );
      if (rewritten === null) return false;
      await provider.updateRecord({
        recordId: current.recordId,
        zoneId: zone.providerZoneId,
        type,
        name,
        value: rewritten,
      });
      this.logger.log(`Removed the Flui include from SPF at ${record.name}`);
      return true;
    }

    // DKIM: ours alone, under a selector the provider issued, and dead the
    // moment it destroys the key.
    const mine = existing.find(
      (r) => unquote(r.value) === unquote(record.value),
    );
    if (!mine) return false;
    await provider.deleteRecord(zone.providerZoneId, mine.recordId);
    this.logger.log(`Deleted ${type} ${record.name} from ${zone.zoneName}`);
    return true;
  }

  /**
   * MX is the one that can take down what the domain already does.
   *
   * A sending domain does not need to receive, and the record the provider asks
   * for reflects that — Scaleway states a *blackhole* host, so mail addressed to
   * the domain is discarded rather than delivered. Publishing that over an
   * existing MX would silently swallow a working inbox, and "silently" is the
   * whole problem: nothing bounces, nothing errors, the mail simply stops
   * arriving and no screen anywhere says so.
   *
   * So it is written only into a domain that has no MX at all. Where one exists
   * this refuses and explains, because the trade — inbound mail for slightly
   * tidier bounce handling — is the operator's to make, not ours.
   */
  private async upsertMx(
    provider: IDnsProvider,
    zone: DnsZoneEntity,
    name: string,
    record: RequiredRecord,
  ): Promise<void> {
    const existing = (await provider.listRecords(zone.providerZoneId)).filter(
      (r) =>
        r.type === DnsRecordType.MX && matchesName(r.name, name, record.name),
    );

    if (
      existing.some(
        (r) =>
          unquote(r.value).replace(/\.$/, '') ===
          unquote(record.value).replace(/\.$/, ''),
      )
    ) {
      return;
    }
    if (existing.length) {
      throw new Error(
        `${record.name} already has an MX record and mail is delivered through it. The provider ` +
          `asks for ${record.value}, which discards inbound mail — replacing the existing record ` +
          `would stop this domain receiving, with nothing to show for it. Publish it by hand if ` +
          `that is what you want.`,
      );
    }

    await provider.createRecord({
      zoneId: zone.providerZoneId,
      type: DnsRecordType.MX,
      name,
      value: valueFor(record),
    });
    this.logger.log(`Created MX ${record.name} in ${zone.zoneName}`);
  }

  /**
   * SPF is the one that cannot be written like the others.
   *
   * A domain may publish **exactly one** SPF record. Adding a second to
   * authorise a new sender does not add a sender — receivers treat several as a
   * permanent error and stop trusting all of them, including whatever was
   * already working. So the provider's `include:` is merged into the record
   * that is already there, and `mergeSpfInclude` puts it *before* the `all`
   * mechanism: a term written after `~all` authorises nothing while looking
   * exactly as though it did.
   */
  private async upsertSpf(
    provider: IDnsProvider,
    zone: DnsZoneEntity,
    name: string,
    fqdn: string,
    requiredValue: string,
  ): Promise<void> {
    const include = includeTarget(requiredValue);
    const records = (await provider.listRecords(zone.providerZoneId)).filter(
      (r) => r.type === DnsRecordType.TXT && matchesName(r.name, name, fqdn),
    );
    const { record: published, duplicates } = findSpf(
      records.map((r) => unquote(r.value)),
    );
    if (duplicates > 0) {
      throw new Error(
        `${zone.zoneName} already publishes ${duplicates + 1} SPF records. A domain may have ` +
          `only one, and receivers treat several as a permanent error — merging into one of ` +
          `them would leave the domain broken. Collapse them into a single record first.`,
      );
    }

    if (!include) {
      // A provider that stated a whole record rather than an include leaves
      // nothing to merge into. Writing it beside an existing one would break
      // the domain, so this stops and says so.
      if (published && unquote(published) !== unquote(requiredValue)) {
        throw new Error(
          `${zone.zoneName} already publishes an SPF record and the provider asked for a ` +
            `different whole record rather than an include. Merging is not safe to guess — ` +
            `reconcile them by hand.`,
        );
      }
      if (!published) {
        await provider.createRecord({
          zoneId: zone.providerZoneId,
          type: DnsRecordType.TXT,
          name,
          value: requiredValue,
        });
      }
      return;
    }

    if (published && hasSpfInclude(published, include)) return;

    const merged = mergeSpfInclude(published, include);
    const target = published
      ? records.find((r) => unquote(r.value) === unquote(published))
      : undefined;

    if (target) {
      await provider.updateRecord({
        recordId: target.recordId,
        zoneId: zone.providerZoneId,
        type: DnsRecordType.TXT,
        name,
        value: merged,
      });
      this.logger.log(
        `Merged include:${include} into the SPF record of ${zone.zoneName}`,
      );
      return;
    }

    await provider.createRecord({
      zoneId: zone.providerZoneId,
      type: DnsRecordType.TXT,
      name,
      value: merged,
    });
    this.logger.log(`Published the first SPF record for ${zone.zoneName}`);
  }

  /**
   * The zone that actually covers this name — the longest matching suffix.
   *
   * Longest wins because both `example.com` and `mail.example.com` can be
   * managed here, and a DKIM record for the second belongs in the second. The
   * shorter zone would accept the write and put the record somewhere that never
   * resolves.
   */
  private async resolveZone(
    name: string,
  ): Promise<{ zone: DnsZoneEntity; provider: IDnsProvider } | null> {
    const needle = name.replace(/\.$/, '').toLowerCase();
    const candidates = (await this.zones.find())
      .filter((zone) => {
        const zoneName = zone.zoneName.replace(/\.$/, '').toLowerCase();
        return needle === zoneName || needle.endsWith(`.${zoneName}`);
      })
      .sort((a, b) => b.zoneName.length - a.zoneName.length);

    for (const zone of candidates) {
      const provider = this.dnsProviders.getDnsProvider(zone.dnsProvider);
      if (provider) return { zone, provider };
      this.logger.warn(
        `Zone ${zone.zoneName} is on ${zone.dnsProvider}, which has no DNS provider registered.`,
      );
    }
    return null;
  }
}

function typeOf(record: RequiredRecord): DnsRecordType {
  if (record.kind === 'MX') return DnsRecordType.MX;
  if (record.kind === 'CNAME') return DnsRecordType.CNAME;
  return DnsRecordType.TXT;
}

/**
 * A CNAME or MX target has to be absolute, or the zone appends its own origin.
 *
 * Brevo issues DKIM as a pair of CNAMEs pointing at `b1.…dkim.brevo.com`; written
 * without the trailing dot, Hetzner stores it as `b1.…dkim.brevo.com.dawit.blog`
 * — a name that is accepted without complaint, resolves to nothing, and leaves
 * the domain unauthenticated while the refusal talks about the sender. It is the
 * same failure as a doubled record *name*, one field over, and just as silent.
 *
 * Only these two kinds: a TXT value is opaque bytes, and a dot appended to one
 * changes what it says.
 */
function valueFor(record: RequiredRecord): string {
  if (record.kind !== 'CNAME' && record.kind !== 'MX') return record.value;
  return `${record.value.trim().replace(/\.$/, '')}.`;
}

/**
 * For a CNAME or MX the trailing dot is not formatting, it is the difference
 * between the target and a name inside our own zone — so a stored value that
 * matches except for the dot is precisely the broken one, and treating it as
 * equal is what let a wrong record survive a re-publish that reported success.
 * Case is not a difference: DNS names are case-insensitive.
 */
function sameValue(record: RequiredRecord, observed: string): boolean {
  const want = unquote(valueFor(record));
  const seen = unquote(observed);
  if (record.kind !== 'CNAME' && record.kind !== 'MX') return seen === want;
  return seen.toLowerCase() === want.toLowerCase();
}

/** `_dmarc.example.com` in zone `example.com` → `_dmarc`; the apex → `@`. */
function relativeName(fqdn: string, zoneName: string): string {
  const name = fqdn.replace(/\.$/, '').toLowerCase();
  const zone = zoneName.replace(/\.$/, '').toLowerCase();
  if (name === zone) return '@';
  return name.slice(0, -(zone.length + 1));
}

/**
 * Providers are not consistent about what `listRecords` returns — relative,
 * absolute, `@` or empty for the apex — so a read matches all of them. Matching
 * only one form means failing to find a record that is right there, and then
 * creating a second one beside it.
 */
function matchesName(
  observed: string,
  relative: string,
  absolute: string,
): boolean {
  const seen = observed.replace(/\.$/, '').toLowerCase();
  const apexForms = ['@', '', absolute.replace(/\.$/, '').toLowerCase()];
  if (relative === '@') return apexForms.includes(seen);
  return (
    seen === relative.toLowerCase() ||
    seen === absolute.replace(/\.$/, '').toLowerCase()
  );
}

/** TXT values come back quoted from some providers and bare from others. */
function unquote(value: string): string {
  return value
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .trim();
}

/** `v=spf1 include:foo.example ~all` → `foo.example`. */
function includeTarget(value: string): string | null {
  const found = value
    .trim()
    .split(/\s+/)
    .find((term) => term.toLowerCase().startsWith('include:'));
  return found ? found.slice('include:'.length) : null;
}

/**
 * Why a record survived the retraction. Never blank: a list of things left
 * behind with no explanation is a list nobody acts on.
 */
function reasonForKeeping(record: RequiredRecord): string {
  if (record.purpose === 'mx') {
    return 'Left in place. Nothing records whether Flui created this MX, and deleting one it did not create stops inbound mail with no error anywhere.';
  }
  if (record.purpose === 'dmarc') {
    return "Left in place. A DMARC policy is the domain's own and may well predate Flui; removing it would quietly drop the protection.";
  }
  if (record.purpose === 'spf') {
    return 'Already gone, or the record never carried the Flui include.';
  }
  return 'Not found — nothing to remove.';
}
