import {
  collectHosts,
  findUnverifiedUrls,
  hostOf,
  normalizeUrl,
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
});
