import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openWithPlatformKey,
  opensWithPlatformKey,
  sealWithPlatformKey,
} from 'src/modules/shared/encryption/platform-cipher';
import {
  PLATFORM_KEY_FIELD,
  migrateEncryptionKeys,
  type ProfileToMigrate,
} from './encryption-key-migration';
import { SealedEncryptionKey } from './sealed-encryption-key';
import { deriveMasterKey, deriveProfileKey } from './vault-crypto';

const MASTER = deriveMasterKey('a passphrase', Buffer.alloc(16, 7));

describe('migrateEncryptionKeys', () => {
  let home: string;
  let cwd: string;
  const fileKey = randomBytes(32);
  const dotenvKey = randomBytes(32);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'flui-ekm-'));
    cwd = mkdtempSync(join(tmpdir(), 'flui-ekm-cwd-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const profile = (name: string): ProfileToMigrate => {
    const dir = join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    return { name, dir, key: deriveProfileKey(MASTER, name) };
  };

  const writeLegacyFile = (): void =>
    writeFileSync(join(home, 'encryption.key'), fileKey.toString('hex'));

  const writeCwdDotenv = (): void =>
    writeFileSync(
      join(cwd, '.env'),
      `PORT=3000\nENCRYPTION_KEY=${dotenvKey.toString('hex')}\n`,
    );

  const cluster = (key: Buffer, secret: string, extra = {}) => ({
    id: secret,
    k3sTokenEncrypted: sealWithPlatformKey(key, `${secret}-k3s`),
    metadata: {
      postgresPasswordEncrypted: sealWithPlatformKey(key, `${secret}-pg`),
      emptyEncrypted: '',
      ...extra,
    },
  });

  const writeClusters = (p: ProfileToMigrate, clusters: unknown[]): void =>
    writeFileSync(join(p.dir, 'clusters.json'), JSON.stringify(clusters));

  const readClusters = (p: ProfileToMigrate): any[] =>
    JSON.parse(readFileSync(join(p.dir, 'clusters.json'), 'utf-8'));

  const run = (profiles: ProfileToMigrate[]) =>
    migrateEncryptionKeys({ profiles, baseDir: home, cwd });

  it('seals the plaintext key into the profile and removes the file', () => {
    const p = profile('default');
    writeLegacyFile();
    writeClusters(p, [cluster(fileKey, 'a')]);

    const report = run([p]);

    expect(report.profiles).toEqual([
      {
        profile: 'default',
        status: 'migrated',
        keyFrom: join(home, 'encryption.key'),
        resealed: 0,
        stamped: 0,
      },
    ]);
    expect(report.legacyFile).toBe('removed');
    expect(existsSync(join(home, 'encryption.key'))).toBe(false);
    expect(new SealedEncryptionKey(p.name, p.dir).open(p.key)).toEqual(fileKey);
    expect(
      readFileSync(join(p.dir, 'encryption.key.sealed'), 'utf-8'),
    ).not.toContain(fileKey.toString('hex'));
  });

  it('picks the key that opens the most values and re-seals the others with it', () => {
    const p = profile('default');
    writeLegacyFile();
    writeCwdDotenv();
    writeClusters(p, [
      cluster(dotenvKey, 'a'),
      cluster(dotenvKey, 'b'),
      cluster(fileKey, 'c'),
    ]);

    const report = run([p]);

    expect(report.profiles[0]).toMatchObject({
      status: 'migrated',
      keyFrom: join(cwd, '.env'),
      resealed: 2,
    });
    const chosen = new SealedEncryptionKey(p.name, p.dir).open(p.key);
    expect(chosen).toEqual(dotenvKey);
    const [, , c] = readClusters(p);
    expect(openWithPlatformKey(chosen, c.k3sTokenEncrypted)).toBe('c-k3s');
    expect(
      openWithPlatformKey(chosen, c.metadata.postgresPasswordEncrypted),
    ).toBe('c-pg');
  });

  it('records on each cluster the plaintext key its installation received when the profile key differs', () => {
    const p = profile('default');
    writeLegacyFile();
    writeCwdDotenv();
    writeClusters(p, [cluster(dotenvKey, 'a'), cluster(dotenvKey, 'b')]);

    const report = run([p]);

    expect(report.profiles[0]).toMatchObject({
      status: 'migrated',
      stamped: 2,
    });
    for (const c of readClusters(p)) {
      expect(
        openWithPlatformKey(dotenvKey, c.metadata[PLATFORM_KEY_FIELD]),
      ).toBe(fileKey.toString('hex'));
    }
  });

  it('prefers the plaintext file when a .env key opens as much', () => {
    const p = profile('default');
    writeLegacyFile();
    writeFileSync(
      join(cwd, '.env'),
      `ENCRYPTION_KEY="${fileKey.toString('hex')}"\n`,
    );
    writeClusters(p, [cluster(fileKey, 'a')]);

    expect(run([p]).profiles[0]).toMatchObject({
      keyFrom: join(home, 'encryption.key'),
      stamped: 0,
    });
  });

  it('leaves a profile untouched when a value opens with no candidate, and keeps the file', () => {
    const p = profile('default');
    const other = profile('other');
    writeLegacyFile();
    writeClusters(p, [cluster(fileKey, 'a'), cluster(randomBytes(32), 'lost')]);
    writeClusters(other, [cluster(fileKey, 'b')]);
    const before = readFileSync(join(p.dir, 'clusters.json'), 'utf-8');

    const report = run([p, other]);

    expect(report.profiles[0]).toMatchObject({
      profile: 'default',
      status: 'failed',
    });
    expect((report.profiles[0] as { reason: string }).reason).toMatch(
      /2 encrypted value\(s\) open with none of the known keys.*clusters\.json\[1\]/,
    );
    expect(readFileSync(join(p.dir, 'clusters.json'), 'utf-8')).toBe(before);
    expect(existsSync(join(p.dir, 'encryption.key.sealed'))).toBe(false);
    expect(report.profiles[1]).toMatchObject({ status: 'migrated' });
    expect(report.legacyFile).toBe('kept');
    expect(existsSync(join(home, 'encryption.key'))).toBe(true);
  });

  it('keeps the key already sealed in the profile and re-seals leftovers with it', () => {
    const p = profile('default');
    const sealedKey = randomBytes(32);
    new SealedEncryptionKey(p.name, p.dir).store(p.key, sealedKey);
    writeLegacyFile();
    writeClusters(p, [
      cluster(fileKey, 'a'),
      cluster(fileKey, 'b'),
      cluster(sealedKey, 'c'),
    ]);

    const report = run([p]);

    expect(report.profiles[0]).toMatchObject({
      status: 'migrated',
      keyFrom: 'the vault',
      resealed: 4,
      stamped: 0,
    });
    for (const c of readClusters(p)) {
      expect(opensWithPlatformKey(sealedKey, c.k3sTokenEncrypted)).toBe(true);
    }
  });

  it('changes nothing when run again', () => {
    const p = profile('default');
    writeLegacyFile();
    writeCwdDotenv();
    writeClusters(p, [cluster(dotenvKey, 'a'), cluster(fileKey, 'b')]);
    run([p]);
    const after = readFileSync(join(p.dir, 'clusters.json'), 'utf-8');

    const again = run([p]);

    expect(again.profiles[0]).toEqual({
      profile: 'default',
      status: 'up-to-date',
    });
    expect(again.legacyFile).toBe('absent');
    expect(readFileSync(join(p.dir, 'clusters.json'), 'utf-8')).toBe(after);
  });

  it('writes nothing for a profile without sealed data', () => {
    const p = profile('empty');
    writeLegacyFile();

    const report = run([p]);

    expect(report.profiles[0]).toEqual({ profile: 'empty', status: 'no-data' });
    expect(existsSync(join(p.dir, 'encryption.key.sealed'))).toBe(false);
    expect(report.legacyFile).toBe('removed');
  });

  it('never writes key material into the report', () => {
    const p = profile('default');
    writeLegacyFile();
    writeCwdDotenv();
    writeClusters(p, [cluster(dotenvKey, 'a'), cluster(randomBytes(32), 'x')]);

    const text = JSON.stringify(run([p]));

    expect(text).not.toContain(fileKey.toString('hex'));
    expect(text).not.toContain(dotenvKey.toString('hex'));
  });
});
