import { randomBytes } from 'node:crypto';
import { EncryptionService } from './encryption.service';
import {
  ENCRYPTION_KEY_UNAVAILABLE_VAR,
  EncryptionKeyUnavailableError,
  openWithPlatformKey,
  sealWithPlatformKey,
} from '../platform-cipher';

const serviceWith = (env: Record<string, string>): EncryptionService =>
  new EncryptionService({ get: (name: string) => env[name] } as never);

describe('EncryptionService', () => {
  const key = randomBytes(32);

  it('round-trips with the key it is given, in the shared stored format', () => {
    const svc = serviceWith({ ENCRYPTION_KEY: key.toString('hex') });
    const sealed = svc.encrypt('a secret');

    expect(openWithPlatformKey(key, sealed)).toBe('a secret');
    expect(svc.decrypt(sealWithPlatformKey(key, 'another'))).toBe('another');
  });

  it('rejects a key of the wrong length at boot', () => {
    expect(() => serviceWith({ ENCRYPTION_KEY: 'abcd' })).toThrow(/32 bytes/);
  });

  describe('when the CLI says no key is available', () => {
    const reason = 'The vault is locked.\n  Unlock it with:  flui vault unlock';
    const svc = () =>
      serviceWith({
        [ENCRYPTION_KEY_UNAVAILABLE_VAR]: reason,
        ENCRYPTION_KEY: key.toString('hex'),
      });

    it('still boots, so commands that open no secret run', () => {
      expect(svc).not.toThrow();
    });

    it('refuses every use of the key with the reason it was given', () => {
      const s = svc();
      for (const use of [
        () => s.encrypt('x'),
        () => s.decrypt(sealWithPlatformKey(key, 'x')),
        () => s.deriveSubkey('any'),
        () => s.exportKeyMaterialForBundle(),
      ]) {
        expect(use).toThrow(EncryptionKeyUnavailableError);
        expect(use).toThrow(reason);
      }
    });

    it('ignores an ENCRYPTION_KEY that leaked in from a .env file', () => {
      expect(() => svc().encrypt('x')).toThrow(EncryptionKeyUnavailableError);
    });
  });
});
