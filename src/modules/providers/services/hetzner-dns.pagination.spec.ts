import { ConfigService } from '@nestjs/config';
import { HetznerDnsService } from './hetzner-dns.service';

function pagination(page: number, last: number) {
  return {
    pagination: {
      page,
      per_page: 50,
      previous_page: page > 1 ? page - 1 : null,
      next_page: page < last ? page + 1 : null,
      last_page: last,
      total_entries: null,
    },
  };
}

function build() {
  const service = new HetznerDnsService(new ConfigService(), {
    getActiveApiToken: jest.fn(async () => 'token'),
  } as never);
  const internals = service as unknown as {
    createZonesApi: () => Promise<unknown>;
    createRRSetsApi: () => Promise<unknown>;
  };
  return { service, internals };
}

describe('HetznerDnsService — pagination', () => {
  it('reads every page of zones, not only the first', async () => {
    const { service, internals } = build();
    const listZones = jest.fn(
      async (_n, _m, _l, _s, page: number, perPage: number) => ({
        data: {
          zones: [{ id: page, name: `zone-${page}.test`, ttl: 3600 }],
          meta: pagination(page, 3),
          perPage,
        },
      }),
    );
    internals.createZonesApi = async () => ({ listZones });

    const zones = await service.listZones();

    expect(zones.map((z) => z.name)).toEqual([
      'zone-1.test',
      'zone-2.test',
      'zone-3.test',
    ]);
    expect(listZones).toHaveBeenCalledTimes(3);
    expect(listZones.mock.calls.map((c) => c[4])).toEqual([1, 2, 3]);
  });

  it('reads every page of records, following the next page the API reports', async () => {
    const { service, internals } = build();
    const listZoneRrsets = jest.fn(
      async (zoneId: string, _n, _t, _l, _s, page: number) => ({
        data: {
          rrsets: [
            {
              id: `r${page}/A`,
              name: `r${page}`,
              type: 'A',
              ttl: 300,
              zone: zoneId,
              records: [{ value: `203.0.113.${page}` }],
              labels: {},
              protection: { change: false },
            },
          ],
          meta: pagination(page, 2),
        },
      }),
    );
    internals.createRRSetsApi = async () => ({ listZoneRrsets });

    const records = await service.listRecords('zone-1');

    expect(records.map((r) => [r.name, r.value])).toEqual([
      ['r1', '203.0.113.1'],
      ['r2', '203.0.113.2'],
    ]);
    expect(listZoneRrsets).toHaveBeenCalledTimes(2);
  });

  it('stops when the API reports no next page even if the page was full', async () => {
    const { service, internals } = build();
    const listZoneRrsets = jest.fn(async () => ({
      data: {
        rrsets: Array.from({ length: 50 }, (_, i) => ({
          name: `n${i}`,
          type: 'A',
          ttl: 300,
          records: [{ value: '203.0.113.1' }],
        })),
        meta: pagination(1, 1),
      },
    }));
    internals.createRRSetsApi = async () => ({ listZoneRrsets });

    await expect(service.listRecords('zone-1')).resolves.toHaveLength(50);
    expect(listZoneRrsets).toHaveBeenCalledTimes(1);
  });
});
