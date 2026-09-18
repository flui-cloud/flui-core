import { RELEASE, pinnedTagForRepository } from './release.config';
import { SYSTEM_APP_CATALOG } from '../modules/applications/constants/system-app-catalog';

describe('pinnedTagForRepository', () => {
  it('returns the tag this release pins for each Flui component', () => {
    expect(pinnedTagForRepository('flui-cloud/core')).toBe(
      RELEASE.images.fluiApi,
    );
    expect(pinnedTagForRepository('flui-cloud/dashboard')).toBe(
      RELEASE.images.fluiWeb,
    );
    expect(pinnedTagForRepository('flui-cloud/flui-authz')).toBe(
      RELEASE.images.fluiAuthz,
    );
  });

  it('returns null for a repository Flui does not pin', () => {
    expect(pinnedTagForRepository('zitadel/zitadel')).toBeNull();
    expect(pinnedTagForRepository('')).toBeNull();
  });

  // A renamed package would silently stop protecting the pinned build in the
  // version listing, so every flui-cloud repository the catalog deploys must
  // resolve here.
  it('covers every flui-cloud repository the system-app catalog declares', () => {
    const declared = SYSTEM_APP_CATALOG.map(
      (app) => app.imageSource?.repository,
    ).filter(
      (repo): repo is string => !!repo && repo.startsWith('flui-cloud/'),
    );

    expect(declared.length).toBeGreaterThan(0);
    for (const repo of declared) {
      expect(pinnedTagForRepository(repo)).not.toBeNull();
    }
  });
});
