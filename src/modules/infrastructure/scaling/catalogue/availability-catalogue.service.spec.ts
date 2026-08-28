import { AvailabilityCatalogueService } from './availability-catalogue.service';
import {
  CatalogueSnapshot,
  VopsCatalogueClient,
} from './vops-catalogue.client';

const snapshot = (
  over: Partial<CatalogueSnapshot> = {},
): CatalogueSnapshot => ({
  provider: 'hetzner',
  published: true,
  shapes: [
    {
      shape: 'cx33',
      state: 'limited',
      everywhere: false,
      upIn: ['hel1'],
      downIn: ['fsn1', 'nbg1'],
    },
  ],
  ageSeconds: 57,
  staleAfterSeconds: 600,
  ...over,
});

interface Stub {
  service: AvailabilityCatalogueService;
  availability: jest.Mock;
  providers: jest.Mock;
}

function stub(over: { enabled?: boolean } = {}): Stub {
  const availability = jest.fn().mockResolvedValue(snapshot());
  const providers = jest.fn().mockResolvedValue(['hetzner', 'scaleway']);
  const client = {
    enabled: over.enabled ?? true,
    availability,
    providers,
  } as unknown as VopsCatalogueClient;
  return {
    service: new AvailabilityCatalogueService(client),
    availability,
    providers,
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-08-27T12:00:00Z') });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('AvailabilityCatalogueService', () => {
  it('reads a provider the catalogue carries', async () => {
    const { service } = stub();

    const reading = await service.read('hetzner');

    expect(reading).toMatchObject({
      state: 'read',
      ageSeconds: 57,
      stale: false,
    });
    expect(reading.shapes).toHaveLength(1);
  });

  describe('when the reading cannot be taken', () => {
    it('says unreachable with no age, and claims nothing about the market', async () => {
      const { service, availability } = stub();
      availability.mockResolvedValue(null);

      const reading = await service.read('hetzner');

      expect(reading).toEqual({
        provider: 'hetzner',
        state: 'unreachable',
        shapes: [],
        ageSeconds: null,
        stale: false,
      });
    });

    it('does not invent a zero age', async () => {
      const { service, availability } = stub();
      availability.mockResolvedValue(null);

      expect((await service.read('hetzner')).ageSeconds).toBeNull();
    });

    it('says off when the catalogue is switched off, without asking', async () => {
      const { service, availability, providers } = stub({ enabled: false });

      expect(await service.read('hetzner')).toMatchObject({ state: 'off' });
      expect(availability).not.toHaveBeenCalled();
      expect(providers).not.toHaveBeenCalled();
    });
  });

  describe('the roster', () => {
    it('skips the request for a provider the catalogue does not carry', async () => {
      const { service, availability } = stub();

      expect(await service.read('ovh')).toMatchObject({
        state: 'not-covered',
      });
      expect(availability).not.toHaveBeenCalled();
    });

    it('asks anyway when the roster itself could not be read', async () => {
      const { service, providers, availability } = stub();
      providers.mockResolvedValue(null);

      expect(await service.read('hetzner')).toMatchObject({ state: 'read' });
      expect(availability).toHaveBeenCalledTimes(1);
    });
  });

  it('says not-published rather than showing an empty market', async () => {
    const { service, availability } = stub();
    availability.mockResolvedValue(snapshot({ published: false, shapes: [] }));

    expect(await service.read('scaleway')).toMatchObject({
      state: 'not-published',
      ageSeconds: 57,
    });
  });

  describe('a held reading', () => {
    it('is served once and aged by the time it was held', async () => {
      const { service, availability } = stub();

      expect((await service.read('hetzner')).ageSeconds).toBe(57);
      jest.setSystemTime(new Date('2026-08-27T12:00:30Z'));
      const later = await service.read('hetzner');

      expect(availability).toHaveBeenCalledTimes(1);
      expect(later.ageSeconds).toBe(57 + 30);
    });

    it('is still served when a refresh fails, as the old reading it is', async () => {
      const { service, availability } = stub();
      await service.read('hetzner');

      availability.mockResolvedValue(null);
      jest.setSystemTime(new Date('2026-08-27T13:00:00Z'));
      const stale = await service.read('hetzner');

      expect(availability).toHaveBeenCalledTimes(2);
      expect(stale.state).toBe('read');
      expect(stale.shapes).toHaveLength(1);
      // An hour of holding is in the number, and the flag says the catalogue's
      // own threshold has been passed.
      expect(stale.ageSeconds).toBe(57 + 3600);
      expect(stale.stale).toBe(true);
    });

    it('keeps an unknown age unknown however long it is held', async () => {
      const { service, availability } = stub();
      availability.mockResolvedValue(snapshot({ ageSeconds: null }));

      await service.read('hetzner');
      jest.setSystemTime(new Date('2026-08-27T13:00:00Z'));

      expect((await service.read('hetzner')).ageSeconds).toBeNull();
    });

    it('refetches once the hold is over', async () => {
      const { service, availability } = stub();
      await service.read('hetzner');
      jest.setSystemTime(new Date('2026-08-27T12:05:00Z'));
      await service.read('hetzner');

      expect(availability).toHaveBeenCalledTimes(2);
    });
  });

  it('collapses simultaneous reads into one request', async () => {
    const { service, availability } = stub();

    await Promise.all([service.read('hetzner'), service.read('hetzner')]);

    expect(availability).toHaveBeenCalledTimes(1);
  });

  it('finds a shape in a reading, and answers null for one it does not name', () => {
    const { service } = stub();
    const reading = {
      provider: 'hetzner',
      state: 'read' as const,
      shapes: snapshot().shapes,
      ageSeconds: 10,
      stale: false,
    };

    expect(service.shapeIn(reading, 'cx33')?.shape).toBe('cx33');
    expect(service.shapeIn(reading, 'cx53')).toBeNull();
  });
});
