import { RELEASE } from '../../../config/release.config';
import { PlatformUpdatesService } from './platform-updates.service';
import { PlatformReleaseEntry } from '../interfaces/release-manifest.interface';

// Anchored to the compiled release so the spec keeps its meaning after a bump.
const NEWER = '99.0.0';

function entry(over: Partial<PlatformReleaseEntry> = {}): PlatformReleaseEntry {
  return {
    version: NEWER,
    publishedAt: '2026-09-02T09:00:00.000Z',
    bootstrapRef: 'abc1234',
    images: { fluiApi: NEWER, fluiWeb: NEWER, fluiAuthz: '0.6.0' },
    notes: ['Something new'],
    migrations: 2,
    requiresBootstrap: false,
    ...over,
  };
}

function build(opts: {
  releases?: PlatformReleaseEntry[];
  manifestError?: string;
  webImageRef?: string | null;
}) {
  const manifest = {
    getManifest: jest.fn().mockImplementation(() => {
      if (opts.manifestError) throw new Error(opts.manifestError);
      return {
        manifest: { schemaVersion: 1, releases: opts.releases ?? [] },
        fetchedAt: new Date('2026-09-05T12:00:00.000Z'),
      };
    }),
  };
  const applications = {
    findByClusterIdAndCategory: jest.fn().mockResolvedValue([
      {
        slug: 'flui-web',
        labels: { app: 'flui-web' },
        imageRef:
          opts.webImageRef === undefined
            ? 'ghcr.io/flui-cloud/dashboard:0.13.0-rc.1'
            : opts.webImageRef,
      },
      {
        slug: 'flui-authz',
        labels: { app: 'flui-authz' },
        imageRef: 'ghcr.io/flui-cloud/flui-authz:0.6.0',
      },
    ]),
  };
  const clusters = {
    findOne: jest.fn().mockResolvedValue({ id: 'control-1' }),
  };
  return new PlatformUpdatesService(
    manifest as never,
    applications as never,
    clusters as never,
  );
}

describe('PlatformUpdatesService', () => {
  it('reports no update when the manifest carries nothing newer', async () => {
    const status = await build({
      releases: [entry({ version: RELEASE.version })],
    }).getStatus();

    expect(status.updateAvailable).toBe(false);
    expect(status.availableVersion).toBeNull();
    expect(status.applicable).toBe(false);
    expect(status.installedVersion).toBe(RELEASE.version);
  });

  it('names the newer release and which components it moves', async () => {
    const status = await build({ releases: [entry()] }).getStatus();

    expect(status.updateAvailable).toBe(true);
    expect(status.availableVersion).toBe(NEWER);
    expect(status.applicable).toBe(true);

    const api = status.components.find((c) => c.key === 'fluiApi');
    const web = status.components.find((c) => c.key === 'fluiWeb');
    const authz = status.components.find((c) => c.key === 'fluiAuthz');
    expect(api).toMatchObject({
      targetVersion: NEWER,
      changed: true,
      restartsControlPlane: true,
    });
    expect(web).toMatchObject({
      installedVersion: '0.13.0-rc.1',
      targetVersion: NEWER,
      changed: true,
    });
    expect(authz).toMatchObject({
      installedVersion: '0.6.0',
      targetVersion: '0.6.0',
      changed: false,
    });
  });

  it('warns about migrations and the API restart', async () => {
    const status = await build({ releases: [entry()] }).getStatus();
    const titles = status.advisories.map((a) => a.title);

    expect(titles).toContain('2 database migrations will run');
    expect(titles).toContain('The API restarts once');
    expect(status.advisories.every((a) => a.level !== 'blocker')).toBe(true);
  });

  it('refuses a release that changes the bootstrap manifests', async () => {
    const status = await build({
      releases: [entry({ requiresBootstrap: true })],
    }).getStatus();

    expect(status.updateAvailable).toBe(true);
    expect(status.applicable).toBe(false);
    expect(status.advisories.some((a) => a.level === 'blocker')).toBe(true);
  });

  it('refuses a release that cannot be reached from the installed version', async () => {
    const status = await build({
      releases: [entry({ minFrom: '98.0.0' })],
    }).getStatus();

    expect(status.applicable).toBe(false);
    expect(status.advisories.map((a) => a.title)).toContain(
      'Update to 98.0.0 first',
    );
  });

  it('reports an unreachable manifest instead of claiming to be up to date', async () => {
    const status = await build({ manifestError: 'HTTP 503' }).getStatus();

    expect(status.checkError).toContain('HTTP 503');
    expect(status.updateAvailable).toBe(false);
    expect(status.applicable).toBe(false);
    expect(status.advisories[0]).toMatchObject({ level: 'blocker' });
  });

  it('falls back to the compiled pin when a component was never discovered', async () => {
    const status = await build({
      releases: [entry()],
      webImageRef: null,
    }).getStatus();

    const web = status.components.find((c) => c.key === 'fluiWeb');
    expect(web?.installedVersion).toBe(RELEASE.images.fluiWeb);
  });
});
