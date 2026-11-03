import { renderReleaseNotes } from '../../scripts/release-notes';
import { ReleaseEntry } from '../../scripts/release-index';

const entry: ReleaseEntry = {
  version: '0.14.0',
  publishedAt: '2026-11-01T00:00:00Z',
  bootstrapRef: 'abc1234',
  images: { fluiApi: '0.14.0', fluiWeb: '0.14.0', fluiAuthz: '0.7.1' },
  notes: ['Clusters across three locations.', 'Replicated volumes.'],
  migrations: 0,
  requiresBootstrap: false,
  k3s: { version: 'v1.35.4+k3s1' },
};

describe('release notes', () => {
  it('lists the authored notes under what is new', () => {
    const md = renderReleaseNotes(entry);
    expect(md).toContain(
      "## What's new\n\n- Clusters across three locations.\n- Replicated volumes.\n",
    );
  });

  it('leaves out what is new when the entry has no notes', () => {
    const md = renderReleaseNotes({ ...entry, notes: [] });
    expect(md).not.toContain("What's new");
    expect(md).toContain('## Install or upgrade');
  });

  it('names the upgrade to exactly this version', () => {
    expect(renderReleaseNotes(entry)).toContain(
      'flui env upgrade --to 0.14.0\n',
    );
  });

  it('lists each image with its registry name, and K3s', () => {
    const md = renderReleaseNotes(entry);
    expect(md).toContain('| API | `ghcr.io/flui-cloud/core:0.14.0` |');
    expect(md).toContain(
      '| Dashboard | `ghcr.io/flui-cloud/dashboard:0.14.0` |',
    );
    expect(md).toContain(
      '| Sign-in relay | `ghcr.io/flui-cloud/flui-authz:0.7.1` |',
    );
    expect(md).toContain('| K3s | `v1.35.4+k3s1` |');
  });

  it('keeps an image it does not know, under its own key', () => {
    const md = renderReleaseNotes({
      ...entry,
      images: { ...entry.images, fluiMail: '0.1.0' },
    });
    expect(md).toContain('| fluiMail | `0.1.0` |');
  });
});
