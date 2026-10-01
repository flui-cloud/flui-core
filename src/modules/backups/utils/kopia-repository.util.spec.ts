import { hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KOPIA_IMAGE,
  KOPIA_VERSION,
  deriveKopiaPassword,
  kopiaEndpoint,
  kopiaIdentityArgs,
  kopiaLocation,
  kopiaRestorePassword,
  kopiaSourcePath,
  kopiaSqliteSourcePath,
  kopiaStorageArgs,
} from './kopia-repository.util';
import {
  kopiaBucketPrefix,
  kopiaRepositoryPrefix,
} from './destination-layout.util';

const APP = '3b0f6a3e-51f1-4c37-9d7e-2f6f0f2d1a10';

describe('kopia repository key', () => {
  it('is HKDF-SHA256 of the destination passphrase bound to the application', () => {
    const expected = Buffer.from(
      hkdfSync('sha256', 'pass', Buffer.alloc(0), `flui/kopia/v1/${APP}`, 32),
    ).toString('base64url');
    expect(deriveKopiaPassword('pass', APP)).toBe(expected);
    expect(deriveKopiaPassword('pass', APP)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is the same every time, and different per application and per passphrase', () => {
    expect(deriveKopiaPassword('pass', APP)).toBe(
      deriveKopiaPassword('pass', APP),
    );
    expect(deriveKopiaPassword('pass', APP)).not.toBe(
      deriveKopiaPassword('pass', 'other-app'),
    );
    expect(deriveKopiaPassword('pass', APP)).not.toBe(
      deriveKopiaPassword('pass2', APP),
    );
  });

  it('keeps a fixed vector, so a change of derivation cannot pass unnoticed', () => {
    expect(deriveKopiaPassword('destination-passphrase', 'app-1')).toBe(
      Buffer.from(
        hkdfSync(
          'sha256',
          'destination-passphrase',
          Buffer.alloc(0),
          'flui/kopia/v1/app-1',
          32,
        ),
      ).toString('base64url'),
    );
  });

  it('refuses to derive from nothing, and a restore never mints a key', () => {
    expect(() => deriveKopiaPassword('', APP)).toThrow(/passphrase/);
    expect(() => kopiaRestorePassword(undefined, APP, 'scw')).toThrow(
      /holds no passphrase/,
    );
    expect(kopiaRestorePassword('pass', APP, 'scw')).toBe(
      deriveKopiaPassword('pass', APP),
    );
  });
});

describe('kopia repository location', () => {
  it('sits in its own folder per application beside the other engines', () => {
    expect(kopiaRepositoryPrefix(APP)).toBe(`kopia/${APP}/`);
    expect(kopiaBucketPrefix('flui/a83dad2e/', APP)).toBe(
      `flui/a83dad2e/kopia/${APP}/`,
    );
    expect(kopiaBucketPrefix(undefined, APP)).toBe(`kopia/${APP}/`);
    expect(() => kopiaRepositoryPrefix('../x')).toThrow();
  });

  it('takes the endpoint as a host, and http as TLS off', () => {
    expect(kopiaEndpoint('https://s3.fr-par.scw.cloud')).toEqual({
      host: 's3.fr-par.scw.cloud',
      disableTls: false,
    });
    expect(kopiaEndpoint('http://minio:9000/')).toEqual({
      host: 'minio:9000',
      disableTls: true,
    });
    expect(kopiaEndpoint('fsn1.your-objectstorage.com')).toEqual({
      host: 'fsn1.your-objectstorage.com',
      disableTls: false,
    });
    expect(() => kopiaEndpoint('https://s3.example.com/bucket')).toThrow(
      /path/,
    );
  });

  it('names no secret among the storage arguments', () => {
    const loc = kopiaLocation(
      {
        bucket: 'b',
        endpoint: 'http://minio:9000',
        region: 'fr-par',
        pathPrefix: 'p',
      },
      APP,
    );
    expect(kopiaStorageArgs(loc)).toEqual([
      's3',
      '--bucket=b',
      '--endpoint=minio:9000',
      `--prefix=p/kopia/${APP}/`,
      '--region=fr-par',
      '--disable-tls',
    ]);
    expect(kopiaIdentityArgs('flui', APP)).toEqual([
      '--override-username=flui',
      `--override-hostname=flui-${APP}`,
    ]);
  });

  it('gives each volume its own source path', () => {
    expect(kopiaSourcePath('data-web-0')).toBe('/flui/volumes/data-web-0');
    expect(kopiaSqliteSourcePath('data-web-0')).toBe(
      '/flui/sqlite/data-web-0/data',
    );
    expect(() => kopiaSourcePath('../etc')).toThrow();
  });
});

describe('one kopia build everywhere', () => {
  it('pins the image by digest, and the API image copies kopia from that same pin', () => {
    expect(KOPIA_IMAGE).toMatch(
      new RegExp(`^kopia/kopia:${KOPIA_VERSION}@sha256:[0-9a-f]{64}$`),
    );
    const dockerfile = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'Dockerfile'),
      'utf-8',
    );
    expect(dockerfile).toContain(`FROM ${KOPIA_IMAGE} AS kopia`);
    expect(dockerfile).toContain(
      'COPY --from=kopia /bin/kopia /usr/local/bin/kopia',
    );
  });
});
