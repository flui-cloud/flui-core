import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { RequiredRecord } from '@flui-cloud/mail';
import { MailDnsWriterService } from './mail-dns-writer.service';
import { DnsZoneEntity } from '../../dns/entities/dns-zone.entity';
import { DnsProviderFactory } from '../../providers/core/factories/dns-provider.factory';
import {
  DnsRecordType,
  type DnsRecordInfo,
} from '../../providers/interfaces/dns-provider.interface';
import { DnsProvider } from '../../providers/enums/dns-provider.enum';

function fakeDnsProvider(seed: Partial<DnsRecordInfo>[] = []) {
  const records = seed.map((r, i) => ({
    recordId: r.recordId ?? `rec-${i}`,
    zoneId: 'zone-1',
    type: r.type ?? DnsRecordType.TXT,
    name: r.name ?? '@',
    value: r.value!,
    ttl: 300,
  })) as DnsRecordInfo[];

  return {
    records,
    listRecords: jest.fn(async () => records),
    createRecord: jest.fn(
      async (c: { name: string; value: string; type: DnsRecordType }) => {
        const row = {
          recordId: `new-${records.length}`,
          zoneId: 'zone-1',
          ttl: 300,
          ...c,
        };
        records.push(row as DnsRecordInfo);
        return row as DnsRecordInfo;
      },
    ),
    updateRecord: jest.fn(async (c: { recordId: string; value: string }) => {
      const row = records.find((r) => r.recordId === c.recordId)!;
      row.value = c.value;
      return row;
    }),
    deleteRecord: jest.fn(async (_zoneId: string, recordId: string) => {
      const at = records.findIndex((r) => r.recordId === recordId);
      if (at >= 0) records.splice(at, 1);
    }),
  };
}

async function build(
  dns: ReturnType<typeof fakeDnsProvider>,
  zones: Partial<DnsZoneEntity>[] = [
    {
      zoneName: 'example.com',
      providerZoneId: 'zone-1',
      dnsProvider: DnsProvider.HETZNER,
    },
  ],
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      MailDnsWriterService,
      {
        provide: getRepositoryToken(DnsZoneEntity),
        useValue: { find: jest.fn(async () => zones) },
      },
      { provide: DnsProviderFactory, useValue: { getDnsProvider: () => dns } },
    ],
  }).compile();
  return moduleRef.get(MailDnsWriterService);
}

const SPF = (value: string): RequiredRecord => ({
  purpose: 'spf',
  kind: 'TXT',
  name: 'example.com',
  value,
});
const MX: RequiredRecord = {
  purpose: 'mx',
  kind: 'MX',
  name: 'example.com',
  value: 'blackhole.tem.scaleway.com',
};
const DKIM: RequiredRecord = {
  purpose: 'dkim',
  kind: 'TXT',
  name: 'sel._domainkey.example.com',
  value: 'v=DKIM1; k=rsa; p=KEY',
};
/** Brevo's shape: the key arrives as a CNAME at a selector it chose. */
const DKIM_CNAME: RequiredRecord = {
  purpose: 'dkim',
  kind: 'CNAME',
  name: 'brevo1._domainkey.example.com',
  value: 'b1.dkim.brevo.com',
};

describe('MailDnsWriterService', () => {
  describe('which zone gets written to', () => {
    it('refuses a domain no managed zone covers, rather than writing somewhere wrong', async () => {
      const service = await build(fakeDnsProvider(), []);
      expect(await service.canWrite('elsewhere.net')).toBe(false);
      await expect(service.upsert(DKIM)).rejects.toThrow(
        /No managed DNS zone covers/,
      );
    });

    it('picks the longest matching zone', async () => {
      // Both zones could claim the name; the shorter one would accept the write
      // and put the record somewhere that never resolves.
      const dns = fakeDnsProvider();
      const service = await build(dns, [
        {
          zoneName: 'example.com',
          providerZoneId: 'zone-short',
          dnsProvider: DnsProvider.HETZNER,
        },
        {
          zoneName: 'mail.example.com',
          providerZoneId: 'zone-1',
          dnsProvider: DnsProvider.HETZNER,
        },
      ]);

      await service.upsert({
        ...DKIM,
        name: 'sel._domainkey.mail.example.com',
      });
      expect(dns.createRecord).toHaveBeenCalledWith(
        expect.objectContaining({ zoneId: 'zone-1', name: 'sel._domainkey' }),
      );
    });

    it('writes the apex as @', async () => {
      const dns = fakeDnsProvider();
      const service = await build(dns);
      await service.upsert(SPF('v=spf1 include:spf.tem.scw.cloud ~all'));
      expect(dns.createRecord).toHaveBeenCalledWith(
        expect.objectContaining({ name: '@' }),
      );
    });
  });

  describe('SPF, where domains get broken', () => {
    it('merges into the existing record instead of publishing a second one', async () => {
      // A domain may publish exactly one SPF record. A second does not add a
      // sender — receivers treat it as a permanent error and stop trusting all
      // of them, including whatever was already working.
      const dns = fakeDnsProvider([
        { value: 'v=spf1 include:_spf.google.com ~all' },
      ]);
      const service = await build(dns);

      await service.upsert(SPF('v=spf1 include:spf.tem.scw.cloud ~all'));

      expect(dns.createRecord).not.toHaveBeenCalled();
      expect(dns.updateRecord).toHaveBeenCalledTimes(1);
      expect(
        dns.records.filter((r) => r.value.startsWith('v=spf1')),
      ).toHaveLength(1);
      expect(dns.records[0]!.value).toContain('include:_spf.google.com');
      expect(dns.records[0]!.value).toContain('include:spf.tem.scw.cloud');
    });

    it('puts the new term before the all mechanism', async () => {
      // A term written after ~all authorises nothing while looking exactly as
      // though it did — the classic silent failure.
      const dns = fakeDnsProvider([
        { value: 'v=spf1 include:_spf.google.com ~all' },
      ]);
      const service = await build(dns);

      await service.upsert(SPF('v=spf1 include:spf.tem.scw.cloud ~all'));

      const terms = dns.records[0]!.value.split(/\s+/);
      expect(terms.indexOf('include:spf.tem.scw.cloud')).toBeLessThan(
        terms.indexOf('~all'),
      );
    });

    it('does nothing when the include is already authorised', async () => {
      const dns = fakeDnsProvider([
        { value: 'v=spf1 include:spf.tem.scw.cloud ~all' },
      ]);
      const service = await build(dns);

      await service.upsert(SPF('v=spf1 include:spf.tem.scw.cloud ~all'));

      expect(dns.updateRecord).not.toHaveBeenCalled();
      expect(dns.createRecord).not.toHaveBeenCalled();
    });

    it('publishes the first record when the domain has none', async () => {
      const dns = fakeDnsProvider();
      const service = await build(dns);

      await service.upsert(SPF('v=spf1 include:spf.tem.scw.cloud ~all'));

      expect(dns.createRecord).toHaveBeenCalledTimes(1);
      expect(dns.records[0]!.value).toContain('include:spf.tem.scw.cloud');
    });

    it('sees a quoted record as the same record', async () => {
      const dns = fakeDnsProvider([
        { value: '"v=spf1 include:spf.tem.scw.cloud ~all"' },
      ]);
      const service = await build(dns);

      await service.upsert(SPF('v=spf1 include:spf.tem.scw.cloud ~all'));
      expect(dns.createRecord).not.toHaveBeenCalled();
    });

    it('finds an SPF record the provider returned in absolute form', async () => {
      // Regression: matching only the relative form here means not seeing the
      // record that is already there, and then publishing a SECOND SPF record —
      // the exact permanent error this whole path exists to avoid.
      const dns = fakeDnsProvider([
        { name: 'example.com', value: 'v=spf1 include:_spf.google.com ~all' },
      ]);
      const service = await build(dns);

      await service.upsert(SPF('v=spf1 include:spf.tem.scw.cloud ~all'));

      expect(dns.createRecord).not.toHaveBeenCalled();
      expect(
        dns.records.filter((r) => r.value.startsWith('v=spf1')),
      ).toHaveLength(1);
      expect(dns.records[0]!.value).toContain('include:_spf.google.com');
      expect(dns.records[0]!.value).toContain('include:spf.tem.scw.cloud');
    });

    it('refuses to merge when the domain already publishes several SPF records', async () => {
      // Merging into one of them leaves the other standing, and the domain
      // stays broken while the write reports success.
      const dns = fakeDnsProvider([
        { value: 'v=spf1 include:_spf.google.com ~all' },
        { recordId: 'rec-dup', value: 'v=spf1 include:mail.zendesk.com ~all' },
      ]);
      const service = await build(dns);

      await expect(
        service.upsert(SPF('v=spf1 include:spf.tem.scw.cloud ~all')),
      ).rejects.toThrow(/already publishes 2 SPF records/);
      expect(dns.updateRecord).not.toHaveBeenCalled();
      expect(dns.createRecord).not.toHaveBeenCalled();
    });

    it('stops rather than guess when the provider wants a whole conflicting record', async () => {
      const dns = fakeDnsProvider([{ value: 'v=spf1 ip4:203.0.113.1 -all' }]);
      const service = await build(dns);

      await expect(
        service.upsert(SPF('v=spf1 ip4:198.51.100.7 -all')),
      ).rejects.toThrow(/not safe to guess/);
      expect(dns.createRecord).not.toHaveBeenCalled();
      expect(dns.updateRecord).not.toHaveBeenCalled();
    });
  });

  describe('the other records', () => {
    it('is idempotent, because it runs in a wait-for-verification loop', async () => {
      const dns = fakeDnsProvider([
        { name: 'sel._domainkey', value: DKIM.value },
      ]);
      const service = await build(dns);

      await service.upsert(DKIM);

      expect(dns.createRecord).not.toHaveBeenCalled();
      expect(dns.updateRecord).not.toHaveBeenCalled();
    });

    it('replaces a rotated key rather than adding a second one', async () => {
      const dns = fakeDnsProvider([
        { name: 'sel._domainkey', value: 'v=DKIM1; k=rsa; p=OLD' },
      ]);
      const service = await build(dns);

      await service.upsert(DKIM);

      expect(dns.updateRecord).toHaveBeenCalledTimes(1);
      expect(dns.records).toHaveLength(1);
      expect(dns.records[0]!.value).toContain('p=KEY');
    });

    it('recognises a record the provider returned in absolute form', async () => {
      // Providers disagree about this, and matching only one form means failing
      // to find a record that is right there — then creating a second beside it.
      const dns = fakeDnsProvider([
        { name: 'sel._domainkey.example.com', value: DKIM.value },
      ]);
      const service = await build(dns);

      await service.upsert(DKIM);
      expect(dns.createRecord).not.toHaveBeenCalled();
    });

    it('writes a CNAME target absolute, so the zone cannot append itself to it', async () => {
      // Without the trailing dot Hetzner stores this as
      // b1.dkim.brevo.com.example.com: written without complaint, resolving to
      // nothing, and the provider's refusal blames the sender instead.
      const dns = fakeDnsProvider();
      const service = await build(dns);

      await service.upsert(DKIM_CNAME);
      expect(dns.createRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          type: DnsRecordType.CNAME,
          name: 'brevo1._domainkey',
          value: 'b1.dkim.brevo.com.',
        }),
      );
    });

    it('corrects a target already stored with the zone appended to it', async () => {
      // The damage is self-healing: the record is found by name and rewritten,
      // rather than a second one being added next to the broken one.
      const dns = fakeDnsProvider([
        {
          type: DnsRecordType.CNAME,
          name: 'brevo1._domainkey',
          value: 'b1.dkim.brevo.com.example.com.',
        },
      ]);
      const service = await build(dns);

      await service.upsert(DKIM_CNAME);
      expect(dns.createRecord).not.toHaveBeenCalled();
      expect(dns.updateRecord).toHaveBeenCalledWith(
        expect.objectContaining({ value: 'b1.dkim.brevo.com.' }),
      );
    });

    it('rewrites a target stored without the dot, which is the broken form', async () => {
      // Hetzner returns exactly what was written and appends the origin only
      // when answering. So a stored `b1.dkim.brevo.com` is not the same record
      // spelled differently — it is the one resolving into our own zone.
      // Reading the dot as formatting is what made a re-publish report success
      // over an unchanged, wrong record.
      const dns = fakeDnsProvider([
        {
          type: DnsRecordType.CNAME,
          name: 'brevo1._domainkey',
          value: 'b1.dkim.brevo.com',
        },
      ]);
      const service = await build(dns);

      await service.upsert(DKIM_CNAME);
      expect(dns.updateRecord).toHaveBeenCalledWith(
        expect.objectContaining({ value: 'b1.dkim.brevo.com.' }),
      );
    });

    it('leaves an already-absolute target alone, so the loop does not churn', async () => {
      const dns = fakeDnsProvider([
        {
          type: DnsRecordType.CNAME,
          name: 'brevo1._domainkey',
          value: 'b1.dkim.brevo.com.',
        },
      ]);
      const service = await build(dns);

      await service.upsert(DKIM_CNAME);
      expect(dns.createRecord).not.toHaveBeenCalled();
      expect(dns.updateRecord).not.toHaveBeenCalled();
    });

    it('maps MX and CNAME onto the right record type', async () => {
      const dns = fakeDnsProvider();
      const service = await build(dns);

      await service.upsert(MX);
      expect(dns.createRecord).toHaveBeenCalledWith(
        expect.objectContaining({ type: DnsRecordType.MX }),
      );
    });

    it('refuses to replace an MX that is already delivering mail', async () => {
      // The record the provider asks for is a blackhole: it discards inbound
      // mail. Writing it over a working inbox stops delivery with nothing
      // bouncing and nothing on screen — the trade is the operator's to make.
      const dns = fakeDnsProvider([
        {
          type: DnsRecordType.MX,
          name: '@',
          value: 'mx1.mailbox-provider.net',
        },
      ]);
      const service = await build(dns);

      await expect(service.upsert(MX)).rejects.toThrow(
        /would stop this domain receiving/,
      );
      expect(dns.createRecord).not.toHaveBeenCalled();
      expect(dns.updateRecord).not.toHaveBeenCalled();
    });

    it('writes the MX into a domain that has none', async () => {
      const dns = fakeDnsProvider([{ value: 'v=spf1 include:other ~all' }]);
      const service = await build(dns);

      await service.upsert(MX);
      expect(dns.createRecord).toHaveBeenCalledTimes(1);
    });

    it('is idempotent on MX, trailing dot and all', async () => {
      const dns = fakeDnsProvider([
        {
          type: DnsRecordType.MX,
          name: '@',
          value: 'blackhole.tem.scaleway.com.',
        },
      ]);
      const service = await build(dns);

      await service.upsert(MX);
      expect(dns.createRecord).not.toHaveBeenCalled();
    });
  });
});

describe('retracting a domain', () => {
  const DMARC: RequiredRecord = {
    purpose: 'dmarc',
    kind: 'TXT',
    name: '_dmarc.example.com',
    value: 'v=DMARC1; p=quarantine',
  };

  it('takes the Flui include back out of the SPF and leaves the rest standing', async () => {
    // The record was merged into, not created. Deleting it would deauthorise
    // every other sender the domain has.
    const dns = fakeDnsProvider([
      {
        value:
          'v=spf1 include:spf.migadu.com include:_spf.tem.scaleway.com -all',
      },
    ]);
    const service = await build(dns);

    const result = await service.retract([
      SPF('include:_spf.tem.scaleway.com'),
    ]);

    expect(dns.records[0]!.value).toBe('v=spf1 include:spf.migadu.com -all');
    expect(dns.deleteRecord).not.toHaveBeenCalled();
    expect(result.removed).toHaveLength(1);
  });

  it('deletes the DKIM record, which is ours and dead once the key is destroyed', async () => {
    const dns = fakeDnsProvider([
      {
        name: 'sel._domainkey',
        type: DnsRecordType.TXT,
        value: 'v=DKIM1; k=rsa; p=KEY',
      },
    ]);
    const service = await build(dns);

    const result = await service.retract([DKIM]);

    expect(dns.deleteRecord).toHaveBeenCalled();
    expect(dns.records).toHaveLength(0);
    expect(result.removed).toEqual(['TXT sel._domainkey.example.com']);
  });

  it('never touches the MX, and says why', async () => {
    // Nothing recorded whether Flui created it. Deleting one it did not create
    // stops inbound mail with no error anywhere.
    const dns = fakeDnsProvider([
      {
        name: '@',
        type: DnsRecordType.MX,
        value: '10 blackhole.tem.scaleway.com',
      },
    ]);
    const service = await build(dns);

    const result = await service.retract([MX]);

    expect(dns.deleteRecord).not.toHaveBeenCalled();
    expect(dns.records).toHaveLength(1);
    expect(result.kept[0]!.reason).toMatch(/inbound mail/);
  });

  it('never touches the DMARC, and says why', async () => {
    const dns = fakeDnsProvider([
      { name: '_dmarc', value: 'v=DMARC1; p=quarantine' },
    ]);
    const service = await build(dns);

    const result = await service.retract([DMARC]);

    expect(dns.deleteRecord).not.toHaveBeenCalled();
    expect(result.kept[0]!.reason).toMatch(/predate/);
  });

  it('reports a record whose zone Flui does not hold instead of failing the lot', async () => {
    const dns = fakeDnsProvider([]);
    const service = await build(dns);

    const result = await service.retract([
      {
        purpose: 'dkim',
        kind: 'TXT',
        name: 'sel._domainkey.elsewhere.test',
        value: 'v=DKIM1',
      },
    ]);

    expect(result.removed).toHaveLength(0);
    expect(result.kept[0]!.reason).toMatch(/does not hold this zone/);
  });

  it('leaves an SPF that never carried our include exactly as it was', async () => {
    const dns = fakeDnsProvider([
      { value: 'v=spf1 include:spf.migadu.com -all' },
    ]);
    const service = await build(dns);

    const result = await service.retract([
      SPF('include:_spf.tem.scaleway.com'),
    ]);

    expect(dns.records[0]!.value).toBe('v=spf1 include:spf.migadu.com -all');
    expect(dns.updateRecord).not.toHaveBeenCalled();
    expect(result.removed).toHaveLength(0);
  });
});
