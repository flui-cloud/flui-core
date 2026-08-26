import {
  isPlatformOwned,
  isUnattributed,
  readDeclaredProvenance,
} from './app-provenance';

/**
 * The vocabulary the bootstrap has been writing for three months and nothing
 * read. These tests pin the two things that must not drift: what counts as a
 * declaration, and what does not.
 */
describe('reading what the manifest declares', () => {
  const labelled = (labels: Record<string, string>) => ({
    metadata: { labels },
  });

  it('reads platform provenance off a resource the bootstrap created', () => {
    expect(
      readDeclaredProvenance(
        labelled({
          'flui.cloud/managed': 'true',
          'flui.cloud/scope': 'system',
          'flui.cloud/owner-kind': 'platform',
          'flui.cloud/owner-id': 'flui-core',
        }),
      ),
    ).toEqual({ ownerKind: 'platform', ownerRef: 'flui-core' });
  });

  it('reads user provenance the same way', () => {
    expect(
      readDeclaredProvenance(labelled({ 'flui.cloud/owner-kind': 'user' })),
    ).toEqual({ ownerKind: 'user', ownerRef: null });
  });

  /**
   * `owner-kind: application` is on the ConfigMaps and Secrets that belong to a
   * workload — loki-config, grafana-config, flui-web-config. It says which app
   * owns a *resource*, not who put the app here. Reading it as a provenance
   * would spend a word somebody else already owns.
   */
  it('does not mistake a resource-to-app label for a provenance', () => {
    expect(
      readDeclaredProvenance(
        labelled({
          'flui.cloud/owner-kind': 'application',
          'flui.cloud/owner-id': 'loki',
        }),
      ),
    ).toEqual({ ownerKind: null, ownerRef: null });
  });

  it('declares nothing for a resource that declares nothing', () => {
    expect(readDeclaredProvenance(labelled({}))).toEqual({
      ownerKind: null,
      ownerRef: null,
    });
    expect(readDeclaredProvenance({})).toEqual({
      ownerKind: null,
      ownerRef: null,
    });
    expect(readDeclaredProvenance(null)).toEqual({
      ownerKind: null,
      ownerRef: null,
    });
  });
});

describe('what a row means once it carries the declaration', () => {
  it('separates the platform from the merely unowned', () => {
    const platform = { userId: null, ownerKind: 'platform' };
    const unregistered = { userId: null };

    expect(isPlatformOwned(platform)).toBe(true);
    expect(isUnattributed(platform)).toBe(false);

    expect(isPlatformOwned(unregistered)).toBe(false);
    expect(isUnattributed(unregistered)).toBe(true);
  });

  it('an owned row is neither', () => {
    const owned = { userId: 'u1' };
    expect(isPlatformOwned(owned)).toBe(false);
    expect(isUnattributed(owned)).toBe(false);
  });
});
