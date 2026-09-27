import {
  ENGINE_PREFIXED_LAYOUT,
  exportsRoot,
  veleroBackupKeyPrefix,
  veleroBslPrefix,
} from './destination-layout.util';

describe('destination layout', () => {
  const fresh = {
    pathPrefix: 'flui/a83dad2e',
    metadata: { layout: ENGINE_PREFIXED_LAYOUT },
  };
  const legacy = { pathPrefix: 'flui/a83dad2e', metadata: {} };

  it('gives Velero a folder of its own so other engines never sit in its prefix', () => {
    expect(veleroBslPrefix(fresh)).toBe('flui/a83dad2e/velero');
    expect(veleroBackupKeyPrefix(fresh, 'b1')).toBe('velero/backups/b1/');
  });

  it('keeps a destination written before the layout where its data is', () => {
    expect(veleroBslPrefix(legacy)).toBe('flui/a83dad2e');
    expect(veleroBackupKeyPrefix(legacy, 'b1')).toBe('backups/b1/');
  });

  it('writes volume exports in their own folder', () => {
    expect(exportsRoot('flui/a83dad2e/', 'flui/cluster')).toBe(
      'flui/a83dad2e/exports',
    );
    expect(exportsRoot(undefined, 'flui/cluster')).toBe('flui/cluster/exports');
  });

  it('works without a destination prefix', () => {
    expect(
      veleroBslPrefix({ metadata: { layout: ENGINE_PREFIXED_LAYOUT } }),
    ).toBe('velero');
    expect(veleroBslPrefix({})).toBeUndefined();
  });
});
