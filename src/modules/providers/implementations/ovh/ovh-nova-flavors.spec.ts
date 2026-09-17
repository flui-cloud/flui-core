import { getOvhNodeSizesFromNova, FlavorPricing } from './ovh-nova-flavors';

const client = (
  byRegion: Record<
    string,
    { name: string; vcpus: number; ram: number; disk: number }[]
  >,
) => ({
  regions: () => Promise.resolve(Object.keys(byRegion)),
  listFlavorsDetail: (region: string) =>
    Promise.resolve(byRegion[region] ?? []),
});

const c34 = { name: 'c3-4', vcpus: 2, ram: 4000, disk: 50 };
const d24 = { name: 'd2-4', vcpus: 2, ram: 4000, disk: 50 };
const r31024 = { name: 'r3-1024', vcpus: 128, ram: 1024000, disk: 400 };

const pricing = new Map<string, FlavorPricing>([
  ['c3-4', { hourly: 0.0457, monthly: 33.36 }],
  ['d2-4', { hourly: 0.0206, monthly: 15.04 }],
]);

describe('getOvhNodeSizesFromNova', () => {
  it('collapses datacenter ids to the code Flui addresses regions by', async () => {
    const sizes = await getOvhNodeSizesFromNova(
      client({ GRA11: [c34], 'EU-SOUTH-MIL': [c34] }),
      pricing,
    );
    expect(sizes).toHaveLength(1);
    expect(sizes[0].availability?.map((a) => a.location).sort()).toEqual([
      'EU-SOUTH-MIL',
      'GRA',
    ]);
  });

  it('reports a region the order catalog has never heard of', async () => {
    const sizes = await getOvhNodeSizesFromNova(
      client({ GRA11: [d24], 'EU-SOUTH-MIL': [c34] }),
      pricing,
    );
    const milan = sizes.filter((s) =>
      s.availability?.some((a) => a.location === 'EU-SOUTH-MIL'),
    );
    expect(milan.map((s) => s.id)).toEqual(['c3-4']);
    // d2 does not exist in Milan, and a size offered where it cannot be
    // created is refused downstream.
    expect(
      sizes.find((s) => s.id === 'd2-4')?.availability?.map((a) => a.location),
    ).toEqual(['GRA']);
  });

  it('sizes memory the way OVH names it, not the way Nova counts it', async () => {
    const sizes = await getOvhNodeSizesFromNova(
      client({ GRA11: [c34, r31024] }),
      pricing,
    );
    // 4000 MiB is 3.9 GiB, and OVH sells it as c3-4 — four gigabytes. Dividing
    // by 1024 would report 3 and hide the shape from a 4 GB minimum.
    expect(sizes.find((s) => s.id === 'c3-4')?.memory).toBe(4);
    expect(sizes.find((s) => s.id === 'r3-1024')?.memory).toBe(1024);
  });

  it('leaves an unpriced flavor unpriced rather than free', async () => {
    const sizes = await getOvhNodeSizesFromNova(
      client({
        'EU-SOUTH-MIL': [{ name: 'b3-8', vcpus: 2, ram: 8000, disk: 50 }],
      }),
      pricing,
    );
    expect(sizes[0].prices).toEqual([]);
    expect(sizes[0].availability).toHaveLength(1);
  });

  it('skips Windows and flex variants, which are not k3s node shapes', async () => {
    const sizes = await getOvhNodeSizesFromNova(
      client({
        GRA11: [
          c34,
          { name: 'win-c3-4', vcpus: 2, ram: 4000, disk: 50 },
          { name: 'c3-4-flex', vcpus: 2, ram: 4000, disk: 50 },
        ],
      }),
      pricing,
    );
    expect(sizes.map((s) => s.id)).toEqual(['c3-4']);
  });
});

describe('what the availability actually claims', () => {
  it('admits that OVH availability was never asked of anyone', async () => {
    // "We do not track this" and "there is none" are opposite answers, and
    // `available: true` on its own reads as the promise it cannot make.
    const sizes = await getOvhNodeSizesFromNova(
      client({ GRA11: [d24] }),
      new Map(),
    );

    for (const entry of sizes[0].availability ?? []) {
      expect(entry.availabilityKnown).toBe(false);
    }
  });
});
