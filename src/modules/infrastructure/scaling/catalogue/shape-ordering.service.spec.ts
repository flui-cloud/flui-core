import { AvailabilityCatalogueService } from './availability-catalogue.service';
import { ShapeAvailability } from './catalogue.core';
import { OrderableGroup, ShapeOrderingService } from './shape-ordering.service';
import {
  CatalogueSnapshot,
  VopsCatalogueClient,
} from './vops-catalogue.client';

const limited = (
  shape: string,
  upIn: string[],
  downIn: string[],
): ShapeAvailability => ({
  shape,
  state: upIn.length ? 'limited' : 'sold-out',
  everywhere: false,
  upIn,
  downIn,
});

const everywhere = (shape: string): ShapeAvailability => ({
  shape,
  state: 'available',
  everywhere: true,
  upIn: [],
  downIn: [],
});

function ordering(
  snapshot: CatalogueSnapshot | null,
  enabled = true,
): ShapeOrderingService {
  const client = {
    enabled,
    providers: jest.fn().mockResolvedValue(['hetzner']),
    availability: jest.fn().mockResolvedValue(snapshot),
  } as unknown as VopsCatalogueClient;
  return new ShapeOrderingService(new AvailabilityCatalogueService(client));
}

const reading = (shapes: ShapeAvailability[]): CatalogueSnapshot => ({
  provider: 'hetzner',
  published: true,
  shapes,
  ageSeconds: 57,
  staleAfterSeconds: 600,
});

const group = (over: Partial<OrderableGroup> = {}): OrderableGroup => ({
  id: 'group-1',
  provider: 'hetzner',
  shapes: ['cx33', 'cx43', 'cx23'],
  regions: ['fsn1', 'nbg1'],
  capability: { hasCatalogue: true },
  ...over,
});

describe('ShapeOrderingService', () => {
  it('puts what the market has first and keeps the group’s own order inside each band', async () => {
    const service = ordering(
      reading([
        limited('cx33', ['hel1'], ['fsn1', 'nbg1']),
        limited('cx43', ['hel1'], ['fsn1', 'nbg1']),
        limited('cx23', ['fsn1', 'nbg1', 'hel1'], []),
      ]),
    );

    const result = await service.order(group());

    // cx23 is up where this group may buy, so it leads; cx33 and cx43 are both
    // down there and keep the order the group wrote.
    expect(result.shapes.map((s) => s.shape)).toEqual(['cx23', 'cx33', 'cx43']);
    expect(result.reading).toBe('read');
  });

  it('ranks a shape the catalogue never names above one it says is gone', async () => {
    const service = ordering(
      reading([limited('cx33', [], ['fsn1', 'nbg1', 'hel1'])]),
    );

    const result = await service.order(group({ shapes: ['cx33', 'ccx13'] }));

    expect(result.shapes.map((s) => s.shape)).toEqual(['ccx13', 'cx33']);
    expect(result.shapes[0].outlook).toBeNull();
    expect(result.shapes[0].why).toContain('rules nothing out');
  });

  it('drops nothing, so the ladder keeps every rung it had', async () => {
    const service = ordering(
      reading([limited('cx33', [], ['fsn1', 'nbg1', 'hel1'])]),
    );

    const result = await service.order(group());

    expect(
      result.shapes
        .filter((s) => s.allowed)
        .map((s) => s.shape)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(['cx23', 'cx33', 'cx43']);
  });

  it('lists shapes the group may not buy, marked, and behind the ones it may', async () => {
    const service = ordering(
      reading([everywhere('cpx41'), limited('cx33', [], ['fsn1', 'nbg1'])]),
    );

    const result = await service.order(group({ shapes: ['cx33'] }));

    expect(result.shapes.map((s) => [s.shape, s.allowed])).toEqual([
      ['cx33', true],
      ['cpx41', false],
    ]);
    expect(result.shapes[1].why).toContain('may not buy');
  });

  describe('the reading’s age', () => {
    it('is carried onto every outlook and onto the envelope', async () => {
      const service = ordering(reading([everywhere('cx23')]));

      const result = await service.order(group({ shapes: ['cx23'] }));

      expect(result.ageSeconds).toBe(57);
      expect(result.shapes[0].outlook?.ageSeconds).toBe(57);
    });

    it('stays null when there is no reading at all', async () => {
      const service = ordering(null);

      const result = await service.order(group());

      expect(result.ageSeconds).toBeNull();
      expect(result.shapes.every((s) => s.outlook === null)).toBe(true);
    });
  });

  it('leaves the group’s preference untouched when the catalogue did not answer', async () => {
    const service = ordering(null);

    const result = await service.order(group());

    expect(result.reading).toBe('unreachable');
    expect(result.shapes.map((s) => s.shape)).toEqual(['cx33', 'cx43', 'cx23']);
    expect(result.says).toContain('Nothing is ruled out');
  });

  it('says the catalogue is off rather than pretending it read one', async () => {
    const service = ordering(reading([]), false);

    expect((await service.order(group())).reading).toBe('off');
  });

  it('reports "up everywhere" against the regions that were asked about', async () => {
    const service = ordering(reading([everywhere('cx23')]));

    const result = await service.order(group({ shapes: ['cx23'] }));

    expect(result.shapes[0].outlook).toEqual({
      state: 'available',
      upIn: ['fsn1', 'nbg1'],
      downIn: [],
      sinceHours: null,
      ageSeconds: 57,
    });
  });

  it('names where a shape can be had when the group may not buy there', async () => {
    const service = ordering(
      reading([limited('cx33', ['hel1'], ['fsn1', 'nbg1'])]),
    );

    const result = await service.order(group({ shapes: ['cx33'] }));

    expect(result.shapes[0].why).toBe(
      'Down where this group may buy. Up in hel1, where this group may not buy.',
    );
    expect(result.shapes[0].outlook).toMatchObject({
      upIn: ['hel1'],
      downIn: ['fsn1', 'nbg1'],
    });
  });

  describe('where the machines are the operator’s own', () => {
    it('says there is no market to read, and does not ask for one', async () => {
      const client = {
        enabled: true,
        providers: jest.fn(),
        availability: jest.fn(),
      } as unknown as VopsCatalogueClient;
      const service = new ShapeOrderingService(
        new AvailabilityCatalogueService(client),
      );

      const result = await service.order(
        group({
          provider: 'byos',
          shapes: [],
          regions: [],
          capability: { hasCatalogue: false },
        }),
      );

      expect(result.reading).toBe('no-market');
      expect(result.shapes).toEqual([]);
      expect(result.ageSeconds).toBeNull();
      expect(result.says).toContain('not the same as a market that came back');
      expect(client.availability).not.toHaveBeenCalled();
    });

    it('does not read the same as a market that answered nothing', async () => {
      const empty = await ordering(reading([])).order(group({ shapes: [] }));
      const byos = await ordering(null).order(
        group({
          provider: 'byos',
          shapes: [],
          regions: [],
          capability: { hasCatalogue: false },
        }),
      );

      expect(empty.shapes).toEqual([]);
      expect(byos.shapes).toEqual([]);
      expect(empty.reading).not.toBe(byos.reading);
      expect(empty.says).not.toBe(byos.says);
    });
  });
});
