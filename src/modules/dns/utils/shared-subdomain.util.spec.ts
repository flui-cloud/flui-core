import {
  buildSharedSubdomain,
  sharedWildcardRecordName,
} from './shared-subdomain.util';

describe('buildSharedSubdomain', () => {
  it('is a label inside the zone the instance already has', () => {
    expect(
      buildSharedSubdomain({ label: 'demo', zoneName: 'flui.cloud' }),
    ).toBe('demo.flui.cloud');
  });

  it('reads a trailing dot and mixed case as the same name', () => {
    expect(
      buildSharedSubdomain({ label: 'DEMO', zoneName: 'Flui.Cloud.' }),
    ).toBe('demo.flui.cloud');
  });

  it('refuses a label a hostname cannot carry', () => {
    for (const label of [
      '',
      'a b',
      '-demo',
      'demo-',
      'de/mo',
      'a'.repeat(64),
    ]) {
      expect(
        buildSharedSubdomain({ label, zoneName: 'flui.cloud' }),
      ).toBeNull();
    }
  });

  it('refuses a zone that is not a hostname', () => {
    expect(buildSharedSubdomain({ label: 'demo', zoneName: '' })).toBeNull();
    expect(
      buildSharedSubdomain({ label: 'demo', zoneName: 'flui .cloud' }),
    ).toBeNull();
  });

  /**
   * A scope with no room for a name underneath is a certificate order spent on
   * nothing: every application below it would be longer than a resolver
   * accepts.
   */
  it('refuses a subdomain that leaves no room for an application under it', () => {
    const zoneName = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}`;
    expect(zoneName).toHaveLength(249);

    expect(buildSharedSubdomain({ label: 'demo', zoneName })).toBeNull();
  });
});

describe('sharedWildcardRecordName', () => {
  it('is the record name a provider wants, relative to the zone', () => {
    expect(sharedWildcardRecordName('demo')).toBe('*.demo');
  });

  it('is nothing at all for a label that is not one', () => {
    expect(sharedWildcardRecordName('not a label')).toBeNull();
  });
});
