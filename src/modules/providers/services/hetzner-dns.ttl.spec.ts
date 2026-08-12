import { ConfigService } from '@nestjs/config';
import { HetznerDnsService } from './hetzner-dns.service';
import { DnsRecordType } from '../interfaces/dns-provider.interface';

/**
 * Hetzner has no "change one value" call, so every edit is a delete of the
 * whole RRSet and a create of a new one. That makes each edit a chance to drop
 * an attribute that was never mentioned — labels were lost that way once, and
 * TTL after them: a record written at 300s came back at the zone default of an
 * hour, so a corrected mistake stayed wrong long after it was fixed, with a
 * zone file that read perfectly.
 */
describe('HetznerDnsService — TTL across a rewrite', () => {
  function build(rrset: { ttl?: number; records: { value: string }[] }) {
    const created: Array<{ ttl?: number; name: string }> = [];
    const api = {
      getZoneRrset: jest.fn(async () => ({ data: { rrset } })),
      deleteZoneRrset: jest.fn(async () => undefined),
      createZoneRrset: jest.fn(
        async (_zoneId: string, request: { ttl?: number; name: string }) => {
          created.push(request);
          return { data: {} };
        },
      ),
    };

    const service = new HetznerDnsService(new ConfigService(), {
      getActiveApiToken: jest.fn(async () => 'token'),
    } as never);
    (
      service as unknown as { createRRSetsApi: () => Promise<unknown> }
    ).createRRSetsApi = async () => api;

    return { service, api, created };
  }

  it('keeps the TTL a record already had when one of its values changes', async () => {
    const { service, created } = build({
      ttl: 300,
      records: [{ value: 'b1.dkim.brevo.com' }],
    });

    await service.updateRecord({
      recordId: 'brevo1._domainkey/CNAME:b1.dkim.brevo.com',
      zoneId: 'zone-1',
      type: DnsRecordType.CNAME,
      name: 'brevo1._domainkey',
      value: 'b1.dkim.brevo.com.',
    });

    expect(created).toHaveLength(1);
    expect(created[0]!.ttl).toBe(300);
  });

  it('honours an explicit TTL over the one the record had', async () => {
    const { service, created } = build({
      ttl: 3600,
      records: [{ value: 'old.example.com' }],
    });

    await service.updateRecord({
      recordId: 'sel/CNAME:old.example.com',
      zoneId: 'zone-1',
      type: DnsRecordType.CNAME,
      name: 'sel',
      value: 'new.example.com.',
      ttl: 60,
    });

    expect(created[0]!.ttl).toBe(60);
  });

  it('does not retime the values that survive a deletion', async () => {
    const { service, created } = build({
      ttl: 300,
      records: [{ value: 'keep.example.com' }, { value: 'drop.example.com' }],
    });

    await service.deleteRecord('zone-1', 'sel/CNAME:drop.example.com');

    expect(created).toHaveLength(1);
    expect(created[0]!.ttl).toBe(300);
  });
});
