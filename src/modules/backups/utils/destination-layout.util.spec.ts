import {
  exportsRoot,
  kopiaBucketPrefix,
  kopiaRepositoryPrefix,
} from './destination-layout.util';

describe('destination layout', () => {
  it('writes volume exports in their own folder', () => {
    expect(exportsRoot('flui/a83dad2e/', 'flui/cluster')).toBe(
      'flui/a83dad2e/exports',
    );
    expect(exportsRoot(undefined, 'flui/cluster')).toBe('flui/cluster/exports');
  });

  it('gives each application its own kopia repository under the destination prefix', () => {
    expect(kopiaRepositoryPrefix('app-1')).toBe('kopia/app-1/');
    expect(kopiaBucketPrefix('/flui/a83dad2e/', 'app-1')).toBe(
      'flui/a83dad2e/kopia/app-1/',
    );
    expect(kopiaBucketPrefix(undefined, 'app-1')).toBe('kopia/app-1/');
  });
});
