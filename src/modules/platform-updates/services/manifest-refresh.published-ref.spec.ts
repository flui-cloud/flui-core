jest.mock('@kubernetes/client-node', () => ({}));

import { ManifestRefreshService } from './manifest-refresh.service';
import { ReleaseManifestService } from './release-manifest.service';
import { RELEASE } from '../../../config/release.config';

function serviceWith(
  releases: Array<{ version: string; bootstrapRef: string }> | Error,
): ManifestRefreshService {
  const manifest = {
    getManifest: jest.fn(() =>
      releases instanceof Error
        ? Promise.reject(releases)
        : Promise.resolve({
            manifest: { schemaVersion: 1, releases },
            fetchedAt: new Date(),
          }),
    ),
  } as unknown as ReleaseManifestService;
  return new ManifestRefreshService(
    {} as never,
    {} as never,
    manifest,
    {} as never,
    {} as never,
  );
}

describe('ManifestRefreshService.isPublishedRef', () => {
  const published = [{ version: '9.9.9', bootstrapRef: 'abc1234' }];

  it('treats no ref as the pinned release', async () => {
    await expect(serviceWith(published).isPublishedRef()).resolves.toBe(true);
  });

  it('accepts the pinned release by commit and by tag', async () => {
    const svc = serviceWith(published);
    await expect(svc.isPublishedRef(RELEASE.bootstrapRef)).resolves.toBe(true);
    await expect(svc.isPublishedRef(`v${RELEASE.version}`)).resolves.toBe(true);
  });

  it('accepts a release from the manifest by commit and by tag', async () => {
    const svc = serviceWith(published);
    await expect(svc.isPublishedRef('abc1234')).resolves.toBe(true);
    await expect(svc.isPublishedRef('v9.9.9')).resolves.toBe(true);
  });

  it('refuses a branch or a commit no release names', async () => {
    const svc = serviceWith(published);
    await expect(svc.isPublishedRef('main')).resolves.toBe(false);
    await expect(svc.isPublishedRef('deadbee')).resolves.toBe(false);
  });

  it('narrows to the pinned release when the manifest cannot be read', async () => {
    const svc = serviceWith(new Error('offline'));
    await expect(svc.isPublishedRef('abc1234')).resolves.toBe(false);
    await expect(svc.isPublishedRef(RELEASE.bootstrapRef)).resolves.toBe(true);
  });
});
