import { ConfigService } from '@nestjs/config';
import { CatalogueHttp } from './catalogue-http';
import { VopsCatalogueClient } from './vops-catalogue.client';

function clientOver(
  getJson: jest.Mock,
  env: Record<string, string> = {},
): VopsCatalogueClient {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new VopsCatalogueClient(config, { getJson } as CatalogueHttp);
}

const report = (over: Record<string, unknown> = {}) => ({
  provider: 'hetzner',
  live: true,
  limited: [],
  everywhere: [],
  ratio: { limited: 0, total: 0 },
  meta: {
    updatedAt: Date.now(),
    ageSeconds: 57,
    staleAfterSeconds: 600,
    stale: false,
  },
  ...over,
});

describe('VopsCatalogueClient', () => {
  it('sends no credential and names only the provider', async () => {
    const getJson = jest.fn().mockResolvedValue(report());
    await clientOver(getJson).availability('hetzner');

    const [url, timeout] = getJson.mock.calls[0] as [string, number];
    expect(url).toBe(
      'https://vops-api.flui.cloud/api/availability?provider=hetzner',
    );
    expect(timeout).toBeGreaterThan(0);
    expect(getJson).toHaveBeenCalledTimes(1);
    // The seam takes a url and a timeout and nothing else: there is no
    // parameter here through which a token could reach the catalogue.
    expect((getJson.mock.calls[0] as unknown[]).length).toBe(2);
  });

  describe('the service is down', () => {
    it('answers null rather than an empty catalogue', async () => {
      const getJson = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(clientOver(getJson).availability('hetzner')).resolves.toBe(
        null,
      );
    });

    it('answers null for the provider roster too', async () => {
      const getJson = jest.fn().mockRejectedValue(new Error('timed out'));

      await expect(clientOver(getJson).providers()).resolves.toBe(null);
    });
  });

  describe('the answer is nonsense', () => {
    it.each([
      ['not an object', 'a string'],
      ['no live flag', report({ live: undefined })],
      ['limited is not a list', report({ limited: {} })],
      ['everywhere is not a list', report({ everywhere: 'cx23' })],
    ])('answers null on %s', async (_case, body) => {
      const getJson = jest.fn().mockResolvedValue(body);

      await expect(clientOver(getJson).availability('hetzner')).resolves.toBe(
        null,
      );
    });

    it('drops an unreadable row and keeps the legible ones', async () => {
      const getJson = jest.fn().mockResolvedValue(
        report({
          limited: [
            {
              plan: 'cx33',
              status: 'limited',
              regions: [{ code: 'hel1', up: true }],
            },
            { status: 'limited', regions: [] },
            { plan: 'cx43', status: 'nonsense', regions: [] },
          ],
        }),
      );

      const snapshot = await clientOver(getJson).availability('hetzner');

      // The dropped rows leave shapes nothing knows about, which excludes
      // nothing; discarding the whole reading would have thrown away cx33.
      expect(snapshot?.shapes.map((s) => s.shape)).toEqual(['cx33']);
    });

    it('reads an empty provider roster as "could not ask"', async () => {
      const getJson = jest.fn().mockResolvedValue({ providers: [] });

      await expect(clientOver(getJson).providers()).resolves.toBe(null);
    });
  });

  it('splits regions into up and down', async () => {
    const getJson = jest.fn().mockResolvedValue(
      report({
        limited: [
          {
            plan: 'cx33',
            status: 'limited',
            regions: [
              { code: 'fsn1', up: false },
              { code: 'nbg1', up: false },
              { code: 'hel1', up: true },
            ],
          },
        ],
      }),
    );

    const snapshot = await clientOver(getJson).availability('hetzner');

    expect(snapshot?.shapes[0]).toEqual({
      shape: 'cx33',
      state: 'limited',
      everywhere: false,
      upIn: ['hel1'],
      downIn: ['fsn1', 'nbg1'],
    });
  });

  it('flags an "up everywhere" shape instead of emitting no regions', async () => {
    const getJson = jest
      .fn()
      .mockResolvedValue(report({ everywhere: ['cx23'] }));

    const snapshot = await clientOver(getJson).availability('hetzner');

    expect(snapshot?.shapes[0]).toMatchObject({
      shape: 'cx23',
      state: 'available',
      everywhere: true,
    });
  });

  it('keeps the age the catalogue reported, and null when it reported none', async () => {
    const withMeta = await clientOver(
      jest.fn().mockResolvedValue(report()),
    ).availability('hetzner');
    expect(withMeta).toMatchObject({ ageSeconds: 57, staleAfterSeconds: 600 });

    const without = await clientOver(
      jest.fn().mockResolvedValue(report({ meta: undefined })),
    ).availability('hetzner');
    expect(without).toMatchObject({ ageSeconds: null });
  });

  it('carries live=false through instead of reading it as an empty market', async () => {
    const getJson = jest.fn().mockResolvedValue(report({ live: false }));

    const snapshot = await clientOver(getJson).availability('contabo');

    expect(snapshot).toMatchObject({ published: false, shapes: [] });
  });

  it('is switched off by declaration and honours a different endpoint', async () => {
    expect(clientOver(jest.fn()).enabled).toBe(true);
    expect(
      clientOver(jest.fn(), { VOPS_CATALOGUE_ENABLED: 'false' }).enabled,
    ).toBe(false);

    const getJson = jest.fn().mockResolvedValue(report());
    await clientOver(getJson, {
      VOPS_CATALOGUE_URL: 'https://catalogue.internal/',
    }).providers();
    expect(getJson.mock.calls[0][0]).toBe(
      'https://catalogue.internal/api/providers',
    );
  });
});
