import { ConfigService } from '@nestjs/config';
import {
  KeyStorageService,
  RETIRED_DEFAULT_KEY_HEX,
} from './key-storage.service';

const A_REAL_KEY =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ANOTHER_REAL_KEY =
  '112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00';

function serviceWith(key?: string): KeyStorageService {
  const config = {
    get: (name: string, fallback?: string) =>
      name === 'SSH_KEY_ENCRYPTION_KEY' ? (key ?? fallback ?? '') : fallback,
  } as unknown as ConfigService;
  return new KeyStorageService(config);
}

describe('KeyStorageService', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('key handling', () => {
    it('refuses a malformed key instead of truncating it', () => {
      // Buffer.from(hex) stops at the first non-hex character, so without this
      // check a typo becomes a short key that fails much later, in a call to a
      // provider, with an error that explains nothing.
      expect(() => serviceWith('not-a-hex-key')).toThrow(
        /64 hexadecimal characters/,
      );
      expect(() => serviceWith('abcd')).toThrow(/got 4/);
      expect(() => serviceWith(`${A_REAL_KEY}ff`)).toThrow(/got 66/);
    });

    it('accepts a well-formed key and reports sealing with it', () => {
      const service = serviceWith(A_REAL_KEY);
      expect(service.sealingWithRetiredKey).toBe(false);
      expect(service.keyFingerprint).toHaveLength(16);
    });

    it('flags an installation with no key configured', () => {
      expect(serviceWith().sealingWithRetiredKey).toBe(true);
    });

    it('flags the retired default even when set explicitly', () => {
      expect(serviceWith(RETIRED_DEFAULT_KEY_HEX).sealingWithRetiredKey).toBe(
        true,
      );
    });

    it('gives different keys different fingerprints', () => {
      expect(serviceWith(A_REAL_KEY).keyFingerprint).not.toEqual(
        serviceWith(ANOTHER_REAL_KEY).keyFingerprint,
      );
    });
  });

  describe('sealing and opening', () => {
    it('round-trips a secret', () => {
      const service = serviceWith(A_REAL_KEY);
      const sealed = service.encryptKeyToString('hcloud-token-value');
      expect(sealed).not.toContain('hcloud-token-value');
      expect(service.decryptKeyFromString(sealed)).toBe('hcloud-token-value');
    });

    it('opens records left behind by the retired default, and says so', () => {
      const legacy = serviceWith(RETIRED_DEFAULT_KEY_HEX);
      const sealed = legacy.encryptKeyToString('an-old-provider-token');

      const upgraded = serviceWith(A_REAL_KEY);
      const opened = upgraded.openFromString(sealed);

      expect(opened.plaintext).toBe('an-old-provider-token');
      expect(opened.stale).toBe(true);
    });

    it('does not mark its own records stale', () => {
      const service = serviceWith(A_REAL_KEY);
      const sealed = service.encryptKeyToString('fresh');
      expect(service.openFromString(sealed).stale).toBe(false);
    });

    it('refuses a record sealed by an unrelated key rather than returning junk', () => {
      const stranger = serviceWith(ANOTHER_REAL_KEY);
      const sealed = stranger.encryptKeyToString('someone-elses-secret');

      expect(() => serviceWith(A_REAL_KEY).openFromString(sealed)).toThrow(
        /not sealed with this installation/,
      );
    });

    it('never seals new records with the retired key once a real one is set', () => {
      const upgraded = serviceWith(A_REAL_KEY);
      const sealed = upgraded.encryptKeyToString('new-token');

      // A service that only knows the retired key must not be able to open it.
      expect(() =>
        serviceWith(RETIRED_DEFAULT_KEY_HEX).openFromString(sealed),
      ).toThrow();
    });

    it('produces a different ciphertext each time for the same plaintext', () => {
      const service = serviceWith(A_REAL_KEY);
      expect(service.encryptKeyToString('same')).not.toEqual(
        service.encryptKeyToString('same'),
      );
    });

    it('rejects a tampered ciphertext', () => {
      const service = serviceWith(A_REAL_KEY);
      const sealed = Buffer.from(
        service.encryptKeyToString('trusted'),
        'base64',
      );
      sealed[sealed.length - 1] ^= 0xff;

      expect(() => service.open(sealed)).toThrow();
    });
  });
});
