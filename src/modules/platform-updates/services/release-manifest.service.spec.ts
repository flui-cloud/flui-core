import { ConfigService } from '@nestjs/config';
import { ReleaseManifestService } from './release-manifest.service';

const images = { fluiApi: '0.13.0', fluiWeb: '0.13.0', fluiAuthz: '0.6.0' };

const schema1Entry = {
  version: '0.12.0',
  publishedAt: '2026-08-01T00:00:00Z',
  bootstrapRef: 'aaa1111',
  images: { ...images, fluiApi: '0.12.0', fluiWeb: '0.12.0' },
  notes: [],
  migrations: 0,
  requiresBootstrap: false,
};

const schema2Entry = {
  version: '0.13.0',
  publishedAt: '2026-09-01T00:00:00Z',
  bootstrapRef: 'bbb2222',
  images,
  notes: ['n'],
  migrations: 2,
  requiresBootstrap: true,
  k3s: { version: 'v1.35.4+k3s1' },
  systemComponents: { certManager: 'v1.17.1' },
  manifestSets: ['control', 'common'],
  somethingFromTheFuture: { ignored: true },
};

function serviceServing(body: unknown): ReleaseManifestService {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as Response);
  return new ReleaseManifestService({
    get: () => undefined,
  } as unknown as ConfigService);
}

describe('ReleaseManifestService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads a schema-1 manifest', async () => {
    const { manifest } = await serviceServing({
      schemaVersion: 1,
      releases: [schema1Entry],
    }).getManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.releases).toHaveLength(1);
    expect(manifest.releases[0].k3s).toBeUndefined();
  });

  it('reads a schema-2 manifest mixing new and old entries', async () => {
    const { manifest } = await serviceServing({
      schemaVersion: 2,
      releases: [schema1Entry, schema2Entry],
    }).getManifest();
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.releases.map((r) => r.version)).toEqual([
      '0.13.0',
      '0.12.0',
    ]);
    expect(manifest.releases[0]).toMatchObject({
      k3s: { version: 'v1.35.4+k3s1' },
      systemComponents: { certManager: 'v1.17.1' },
      manifestSets: ['control', 'common'],
    });
    expect(manifest.releases[1].k3s).toBeUndefined();
  });

  it('still rejects an entry without image tags', async () => {
    const { manifest } = await serviceServing({
      schemaVersion: 2,
      releases: [
        schema2Entry,
        { ...schema2Entry, version: '0.14.0', images: {} },
      ],
    }).getManifest();
    expect(manifest.releases.map((r) => r.version)).toEqual(['0.13.0']);
  });
});
