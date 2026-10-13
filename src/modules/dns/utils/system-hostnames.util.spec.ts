import {
  DEFAULT_SYSTEM_LABELS,
  hostnameProblem,
  labelUnderZone,
  normalizeHostnameInput,
  wildcardLabelProblem,
} from './system-hostnames.util';

describe('system hostnames', () => {
  it('keeps the names the platform has always used by default', () => {
    expect(DEFAULT_SYSTEM_LABELS).toEqual({
      'flui-web': 'dashboard',
      'flui-api': 'api',
      zitadel: 'auth',
    });
  });

  it('normalises what a person typed', () => {
    expect(normalizeHostnameInput('  Dashboard-Demo. ')).toBe('dashboard-demo');
    expect(normalizeHostnameInput(undefined)).toBe('');
  });

  describe('a name under the wildcard certificate', () => {
    it.each(['dashboard', 'dashboard-demo', 'a', 'x1', 'a'.repeat(63)])(
      'accepts %s',
      (label) => {
        expect(wildcardLabelProblem(label, 'flui.cloud')).toBeNull();
      },
    );

    it('refuses a dot and says why', () => {
      expect(wildcardLabelProblem('dashboard.demo', 'flui.cloud')).toBe(
        'Use one name without dots: the certificate for *.flui.cloud covers a single level.',
      );
    });

    it.each([
      ['', 'Enter a name.'],
      ['-demo', 'cannot start or end with a hyphen'],
      ['demo-', 'cannot start or end with a hyphen'],
      ['dash_board', 'lowercase letters, digits and hyphens'],
      ['a'.repeat(64), 'longer than 63 characters'],
    ])('refuses "%s"', (label, expected) => {
      expect(wildcardLabelProblem(label, 'flui.cloud')).toContain(expected);
    });

    it('refuses a name that makes the address too long', () => {
      const zone = `${'z'.repeat(63)}.${'y'.repeat(63)}.${'x'.repeat(63)}.io`;
      expect(wildcardLabelProblem('a'.repeat(60), zone)).toContain(
        'longer than 253 characters',
      );
    });
  });

  describe('a full address', () => {
    it.each([
      'dashboard.example.com',
      'dashboard.demo.example.com',
      'web.1-2-3-4.nip.io',
    ])('accepts %s', (fqdn) => {
      expect(hostnameProblem(fqdn)).toBeNull();
    });

    it.each([
      ['', 'Enter an address.'],
      ['localhost', 'Use a full address'],
      ['a..example.com', 'empty parts'],
      ['bad_name.example.com', '"bad_name"'],
      [`${'a'.repeat(63)}.`.repeat(4) + 'com', 'at most 253 characters'],
    ])('refuses "%s"', (fqdn, expected) => {
      expect(hostnameProblem(fqdn)).toContain(expected);
    });
  });

  describe('the label an address uses under a zone', () => {
    it('reads one label', () => {
      expect(labelUnderZone('dashboard-demo.flui.cloud', 'flui.cloud')).toBe(
        'dashboard-demo',
      );
    });

    it.each([
      [null],
      ['flui.cloud'],
      ['a.b.flui.cloud'],
      ['dashboard.other.cloud'],
      ['dashboard.notflui.cloud'],
    ])('has none for %s', (fqdn) => {
      expect(labelUnderZone(fqdn, 'flui.cloud')).toBeNull();
    });
  });
});
