import { CatalogueShape, planHaCreation } from './ha-creation-plan.core';
import { HaTopology } from '../../../providers/core/ha-topology';

const EU_CENTRAL: HaTopology = {
  region: 'eu-central',
  zones: ['fsn1', 'nbg1', 'hel1'],
  dataZones: ['fsn1', 'nbg1'],
  validated: true,
  measured: true,
};

function shape(
  name: string,
  architecture: string,
  zones: Record<string, boolean>,
  monthly: string,
): CatalogueShape {
  return {
    name,
    architecture,
    availability: Object.entries(zones).map(([location, available]) => ({
      location,
      available,
    })),
    prices: Object.keys(zones).map((location) => ({
      location,
      priceMonthly: { net: monthly },
    })),
  };
}

// Some sizes out in some locations, as Hetzner reports them.
const CATALOGUE = [
  shape('cax11', 'arm', { fsn1: false, nbg1: false, hel1: false }, '5.99'),
  shape('cx23', 'x86', { fsn1: true, nbg1: false, hel1: false }, '3.49'),
  shape('cpx22', 'x86', { fsn1: true, nbg1: true, hel1: true }, '19.49'),
  shape('ccx13', 'x86', { fsn1: true, nbg1: true, hel1: true }, '42.99'),
];

const base = {
  topology: EU_CENTRAL,
  firstZone: 'fsn1',
  workerCount: 0,
  catalogue: CATALOGUE,
  completeLater: false,
};

describe('planHaCreation', () => {
  it('puts one server in each location, the other location for data before the one that votes', () => {
    const answer = planHaCreation({ ...base, shapes: ['cpx22'] });

    expect(answer.plan).toEqual({
      region: 'eu-central',
      first: { zone: 'fsn1', shape: 'cpx22' },
      servers: [
        { zone: 'nbg1', shape: 'cpx22' },
        { zone: 'hel1', shape: 'cpx22' },
      ],
      later: [],
    });
  });

  it('gives each location the first size it has available', () => {
    const answer = planHaCreation({ ...base, shapes: ['cx23', 'cpx22'] });

    expect(answer.plan?.first).toEqual({ zone: 'fsn1', shape: 'cx23' });
    expect(answer.plan?.servers).toEqual([
      { zone: 'nbg1', shape: 'cpx22' },
      { zone: 'hel1', shape: 'cpx22' },
    ]);
  });

  it('buys nothing when a location has none of the sizes, and names the sizes every location has', () => {
    const answer = planHaCreation({ ...base, shapes: ['cx23'] });

    expect(answer.plan).toBeNull();
    expect(answer).toMatchObject({
      completeLaterHelps: true,
      refusal:
        'nbg1 and hel1 have none of cx23 available now. Sizes every location has: cpx22 (€19.49/month), ccx13 (€42.99/month).',
    });
  });

  it('only proposes sizes of the same architecture', () => {
    const answer = planHaCreation({ ...base, shapes: ['cax11'] });

    expect(answer).toMatchObject({
      refusal:
        'fsn1, nbg1 and hel1 have none of cax11 available now. No arm size is available in all three locations right now.',
    });
  });

  it('leaves a location for later only when asked, and never the first one', () => {
    const later = planHaCreation({
      ...base,
      shapes: ['cx23'],
      completeLater: true,
    });
    expect(later.plan).toMatchObject({
      first: { zone: 'fsn1', shape: 'cx23' },
      servers: [],
      later: ['nbg1', 'hel1'],
    });

    const noFirst = planHaCreation({
      ...base,
      firstZone: 'nbg1',
      shapes: ['cx23'],
      completeLater: true,
    });
    expect(noFirst.plan).toBeNull();
  });

  it('refuses a first server in the location that only votes', () => {
    const answer = planHaCreation({
      ...base,
      firstZone: 'hel1',
      shapes: ['cpx22'],
    });

    expect(answer).toMatchObject({
      refusal: 'The first server goes in a location for data: fsn1 or nbg1.',
    });
  });

  it('refuses sizes of two architectures', () => {
    const answer = planHaCreation({ ...base, shapes: ['cax11', 'cpx22'] });

    expect(answer).toMatchObject({
      refusal:
        'These sizes mix arm and x86; a cluster runs on one architecture.',
    });
  });

  it('refuses workers at creation and a region with no layout', () => {
    expect(
      planHaCreation({ ...base, workerCount: 1, shapes: ['cpx22'] }).plan,
    ).toBeNull();
    expect(
      planHaCreation({
        ...base,
        topology: null,
        unsupported:
          'Flui has not validated a highly available layout for us-east yet.',
        shapes: ['cpx22'],
      }),
    ).toMatchObject({
      refusal:
        'Flui has not validated a highly available layout for us-east yet.',
    });
  });
});

describe('planHaCreation where the catalogue is by region', () => {
  const PAR: HaTopology = {
    region: 'fr-par',
    zones: ['fr-par-1', 'fr-par-2', 'fr-par-3'],
    dataZones: ['fr-par-1', 'fr-par-2', 'fr-par-3'],
    validated: true,
    measured: true,
  };
  const byRegion = (
    name: string,
    location: string,
    zones?: string[],
  ): CatalogueShape => ({
    name,
    architecture: 'x86',
    availability: [{ location, available: true, zones }],
    prices: [{ location, priceMonthly: { net: '28.47' } }],
  });

  it('counts a size sold in the region for every zone the region names', () => {
    const answer = planHaCreation({
      topology: PAR,
      firstZone: 'fr-par-1',
      workerCount: 0,
      completeLater: false,
      shapes: ['BASIC3-X2C-4G', 'PRO2-XXS'],
      catalogue: [
        byRegion('BASIC3-X2C-4G', 'fr-par', ['fr-par-1', 'fr-par-2']),
        byRegion('PRO2-XXS', 'fr-par', ['fr-par-1', 'fr-par-2', 'fr-par-3']),
      ],
    });

    expect(answer.plan).toEqual({
      region: 'fr-par',
      first: { zone: 'fr-par-1', shape: 'BASIC3-X2C-4G' },
      servers: [
        { zone: 'fr-par-2', shape: 'BASIC3-X2C-4G' },
        { zone: 'fr-par-3', shape: 'PRO2-XXS' },
      ],
      later: [],
    });
  });

  it('counts a region that does not say which zones sell a size for all of them, whatever its case', () => {
    const answer = planHaCreation({
      topology: {
        ...PAR,
        region: 'eu-west-par',
        zones: ['eu-west-par-a', 'eu-west-par-b', 'eu-west-par-c'],
        dataZones: ['eu-west-par-a', 'eu-west-par-b', 'eu-west-par-c'],
      },
      firstZone: 'eu-west-par-a',
      workerCount: 0,
      completeLater: false,
      shapes: ['c3-4'],
      catalogue: [byRegion('c3-4', 'EU-WEST-PAR')],
    });

    expect(answer.plan?.servers.map((s) => s.zone)).toEqual([
      'eu-west-par-b',
      'eu-west-par-c',
    ]);
  });
});
