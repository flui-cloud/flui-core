jest.mock('@kubernetes/client-node', () => ({}));

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
  apiImageRef?: string | null;
  /** What the control cluster answers per deployment, for components with no row. */
  clusterImages?: Record<string, string | null>;
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
      ...(opts.webImageRef === null
        ? []
        : [
            {
              slug: 'flui-web',
              labels: { app: 'flui-web' },
              imageRef:
                opts.webImageRef ?? 'ghcr.io/flui-cloud/dashboard:0.13.0-rc.1',
            },
          ]),
      ...(opts.apiImageRef === null
        ? []
        : [
            {
              slug: 'flui-api',
              labels: { app: 'flui-api' },
              imageRef:
                opts.apiImageRef ??
                `ghcr.io/flui-cloud/core:${RELEASE.images.fluiApi}`,
            },
          ]),
    ]),
  };
  const clusters = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 'control-1', kubeconfigEncrypted: 'enc' }),
  };
  const clusterImages: Record<string, string | null> = {
    'flui-authz': 'ghcr.io/flui-cloud/flui-authz:0.6.0',
    ...(opts.clusterImages ?? {}),
  };
  const kubernetes = {
    getDeploymentContainerImage: jest
      .fn()
      .mockImplementation((_kubeconfig, _ns, deployment: string) =>
        Promise.resolve(clusterImages[deployment] ?? null),
      ),
  };
  const encryption = { decrypt: jest.fn().mockReturnValue('kubeconfig') };
  return new PlatformUpdatesService(
    manifest as never,
    applications as never,
    clusters as never,
    kubernetes as never,
    encryption as never,
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

  it('calls a commit-built component out instead of reading it as a version', async () => {
    const status = await build({
      releases: [entry()],
      webImageRef: 'ghcr.io/flui-cloud/dashboard:ec9f4b1',
    }).getStatus();

    const web = status.components.find((c) => c.key === 'fluiWeb');
    expect(web?.installedVersion).toBe('ec9f4b1');
    expect(web?.installedIsRelease).toBe(false);
    // Uncomparable is not "the same": the release still has somewhere to move it.
    expect(web?.changed).toBe(true);
    expect(status.advisories.map((a) => a.title)).toContain(
      'flui-web is running a build, not a release',
    );
  });

  it('warns about a commit build even when there is no release to offer', async () => {
    const status = await build({
      releases: [entry({ version: RELEASE.version })],
      webImageRef: 'ghcr.io/flui-cloud/dashboard:ec9f4b1',
    }).getStatus();

    expect(status.updateAvailable).toBe(false);
    expect(
      status.components.find((c) => c.key === 'fluiWeb')?.installedIsRelease,
    ).toBe(false);
    expect(status.advisories.some((a) => a.level === 'warning')).toBe(true);
  });

  it('reports what the cluster runs for the API, not the build answering the request', async () => {
    const status = await build({
      releases: [entry()],
      apiImageRef: 'ghcr.io/flui-cloud/core:0.12.9',
    }).getStatus();

    expect(
      status.components.find((c) => c.key === 'fluiApi')?.installedVersion,
    ).toBe('0.12.9');
  });

  it('asks the cluster when a component has no row, rather than trusting a pin', async () => {
    const status = await build({
      releases: [entry()],
      webImageRef: null,
      clusterImages: { 'flui-web': 'ghcr.io/flui-cloud/dashboard:0.12.9' },
    }).getStatus();

    const web = status.components.find((c) => c.key === 'fluiWeb');
    expect(web).toMatchObject({
      installed: true,
      observed: true,
      installedVersion: '0.12.9',
    });
  });

  it('reports a component that is on no cluster as not installed, and never invents a version for it', async () => {
    const status = await build({
      releases: [entry()],
      clusterImages: { 'flui-authz': null },
    }).getStatus();

    // flui-authz has neither a row nor a workload in this fixture.
    const authz = status.components.find((c) => c.key === 'fluiAuthz');
    expect(authz).toMatchObject({
      installed: false,
      installedVersion: null,
      changed: false,
    });
  });
});
