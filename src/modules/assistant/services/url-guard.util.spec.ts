import {
  collectHosts,
  findUnverifiedUrls,
  hostOf,
  isPlaceholderHost,
  normalizeUrl,
  stripUrls,
} from './url-guard.util';

describe('url-guard.util', () => {
  describe('normalizeUrl / hostOf', () => {
    it('drops a trailing slash and surrounding punctuation', () => {
      expect(normalizeUrl('https://a-b.203-0-113-7.nip.io/.')).toBe(
        'https://a-b.203-0-113-7.nip.io',
      );
    });
    it('lowercases and extracts the host', () => {
      expect(hostOf('https://Immich.Photos.ACME.com/login')).toBe(
        'immich.photos.acme.com',
      );
    });
  });

  describe('collectHosts', () => {
    it('gathers every host from tool-result / user text', () => {
      const hosts = collectHosts([
        '{"url":"https://it-tools-3l6a9w.203-0-113-7.nip.io/"}',
        'la mia app è su https://my-app.acme.com',
      ]);
      expect(hosts).toEqual(
        new Set(['it-tools-3l6a9w.203-0-113-7.nip.io', 'my-app.acme.com']),
      );
    });
  });

  describe('findUnverifiedUrls', () => {
    it('flags a URL whose host is not in the allow-set (mode-agnostic)', () => {
      const allowed = new Set(['it-tools-3l6a9w.203-0-113-7.nip.io']);
      // Fabricated immich URL under a DIFFERENT domain — slug/domain heuristics miss this.
      const content =
        "L'endpoint di Immich è https://immich-444f95-server.flui.app.";
      expect(findUnverifiedUrls(content, allowed)).toEqual([
        'https://immich-444f95-server.flui.app',
      ]);
    });

    it('allows a host that is in the allow-set, with any path', () => {
      const allowed = new Set(['immich.photos.acme.com']);
      const content = 'Aprila qui: https://immich.photos.acme.com/login';
      expect(findUnverifiedUrls(content, allowed)).toEqual([]);
    });

    it('flags a fabricated URL even when no real endpoint exists (empty allow-set)', () => {
      const content = 'https://immich-444f95-server.flui.app/';
      expect(findUnverifiedUrls(content, new Set())).toHaveLength(1);
    });

    it('de-duplicates repeated offenders', () => {
      const content = 'https://x.flui.app and again https://x.flui.app/';
      expect(findUnverifiedUrls(content, new Set())).toEqual([
        'https://x.flui.app',
      ]);
    });
  });

  describe('placeholders', () => {
    it.each([
      'example.com',
      'app.example.com',
      'example.org',
      'localhost',
      'localhost:3000',
      '127.0.0.1:8080',
      '203.0.113.7',
      'app.your-domain.com',
      'yourdomain.com',
      'my-app.test',
      'api.local',
    ])('treats %s as a placeholder', (host) => {
      expect(isPlaceholderHost(host)).toBe(true);
    });

    it.each([
      'immich-444f95-server.flui.app',
      'my-app.203-0-113-7.nip.io',
      'api.acme.com',
      'examples.dev',
    ])('treats %s as a real-looking host', (host) => {
      expect(isPlaceholderHost(host)).toBe(false);
    });

    it('never flags placeholder or template URLs', () => {
      const content = [
        'Open https://app.example.com or http://localhost:3000/health.',
        'Your app lives at https://app.<your-domain> once DNS is set.',
        'Template: https://{{ app }}.acme.com',
      ].join('\n');
      expect(findUnverifiedUrls(content, new Set())).toEqual([]);
    });
  });

  describe('stripUrls', () => {
    it('keeps the label of a markdown link', () => {
      expect(
        stripUrls('See [the guide](https://x.flui.app/guide).', [
          'https://x.flui.app/guide',
        ]),
      ).toBe('See the guide.');
    });

    it('puts a bare placeholder inside code and an inline-code one in prose', () => {
      const content =
        'Visit https://x.flui.app now.\n```yaml\nurl: https://x.flui.app\n```';
      expect(stripUrls(content, ['https://x.flui.app'])).toBe(
        'Visit `<app-url>` now.\n```yaml\nurl: <app-url>\n```',
      );
    });

    it('leaves other URLs untouched', () => {
      const content = 'Docs: https://docs.flui.cloud/a and https://x.flui.app';
      expect(stripUrls(content, ['https://x.flui.app'])).toBe(
        'Docs: https://docs.flui.cloud/a and `<app-url>`',
      );
    });
  });
});
