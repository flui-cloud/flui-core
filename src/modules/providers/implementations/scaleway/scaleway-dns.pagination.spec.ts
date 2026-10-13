import { ScalewayDnsService } from './scaleway-dns.service';

function build() {
  const service = new ScalewayDnsService({
    getActiveApiToken: jest.fn(async () => 'token'),
  } as never);
  const internals = service as unknown as {
    createZonesApi: () => Promise<unknown>;
    createRecordsApi: () => Promise<unknown>;
  };
  return { service, internals };
}

function page<T>(all: T[], pageNumber: number, size: number) {
  return all.slice((pageNumber - 1) * size, pageNumber * size);
}

describe('ScalewayDnsService — pagination', () => {
  it('reads every page of zones, not only the first', async () => {
    const { service, internals } = build();
    const all = Array.from({ length: 150 }, (_, i) => ({
      domain: 'example.com',
      subdomain: `z${i}`,
    }));
    const listDNSZones = jest.fn(
      async (_d, _z, _o, _p, _ob, pageNumber: number, size: number) => ({
        data: {
          dns_zones: page(all, pageNumber, size),
          total_count: all.length,
        },
      }),
    );
    internals.createZonesApi = async () => ({ listDNSZones });

    const zones = await service.listZones();

    expect(zones).toHaveLength(150);
    expect(zones[149].name).toBe('z149.example.com');
    expect(listDNSZones).toHaveBeenCalledTimes(2);
  });

  it('reads every page of records, so a name on a later page is still seen', async () => {
    const { service, internals } = build();
    const all = Array.from({ length: 230 }, (_, i) => ({
      id: `r${i}`,
      name: `n${i}`,
      type: 'A',
      data: '203.0.113.1',
      ttl: 300,
    }));
    const listDNSZoneRecords = jest.fn(
      async (_zone, _name, _p, _ob, pageNumber: number, size: number) => ({
        data: {
          records: page(all, pageNumber, size),
          total_count: all.length,
        },
      }),
    );
    internals.createRecordsApi = async () => ({ listDNSZoneRecords });

    const records = await service.listRecords('example.com');

    expect(records).toHaveLength(230);
    expect(records.some((r) => r.name === 'n229')).toBe(true);
    expect(listDNSZoneRecords).toHaveBeenCalledTimes(3);
  });

  it('stops on an empty page when the total is not reported', async () => {
    const { service, internals } = build();
    const listDNSZoneRecords = jest.fn(async () => ({
      data: { records: [] },
    }));
    internals.createRecordsApi = async () => ({ listDNSZoneRecords });

    await expect(service.listRecords('example.com')).resolves.toEqual([]);
    expect(listDNSZoneRecords).toHaveBeenCalledTimes(1);
  });
});

describe('ScalewayDnsService — private network zones', () => {
  it('leaves out the zones Scaleway keeps for private networks', async () => {
    const { service, internals } = build();
    const listDNSZones = jest.fn(async () => ({
      data: {
        dns_zones: [
          { domain: 'fluicloud.eu', subdomain: '' },
          {
            domain: 'a1937079-a302-4684-8647-3260963d98b9.privatedns',
            subdomain: '127cfffe-93f2-4069-8857-5cd4c2195924',
          },
          {
            domain: 'internal.example',
            subdomain: '',
            linked_products: ['vpc'],
          },
        ],
        total_count: 3,
      },
    }));
    internals.createZonesApi = async () => ({ listDNSZones });

    const zones = await service.listZones();

    expect(zones.map((z) => z.name)).toEqual(['fluicloud.eu']);
  });
});
