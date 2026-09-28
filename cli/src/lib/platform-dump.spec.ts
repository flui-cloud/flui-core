import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  openPlatformDump,
  PlatformDumpError,
  writeSecureKeys,
} from './platform-dump';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flui-restore-'));
}

describe('writeSecureKeys', () => {
  it('writes the recorded key tree under secure-keys, owner-only', () => {
    const out = tmp();
    writeSecureKeys(out, [
      {
        relPath: 'clusters/c1/bootstrap.key',
        mode: '600',
        contentBase64: Buffer.from('KEY').toString('base64'),
      },
    ]);
    const file = path.join(out, 'secure-keys/clusters/c1/bootstrap.key');
    expect(fs.readFileSync(file, 'utf-8')).toBe('KEY');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('never writes outside the key directory', () => {
    const out = tmp();
    expect(() =>
      writeSecureKeys(out, [
        { relPath: '../../escape', mode: '600', contentBase64: 'eA==' },
      ]),
    ).toThrow('outside the key directory');
    expect(fs.existsSync(path.join(out, '..', 'escape'))).toBe(false);
  });
});

describe('writeSecureKeys — what it refuses to write through', () => {
  const key = (relPath: string) => ({
    relPath,
    mode: '600',
    contentBase64: Buffer.from('KEY').toString('base64'),
  });

  it('refuses a directory inside the key tree that is a symbolic link', () => {
    const out = tmp();
    const elsewhere = tmp();
    fs.mkdirSync(path.join(out, 'secure-keys'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(out, 'secure-keys/clusters'));
    expect(() => writeSecureKeys(out, [key('clusters/c1.key')])).toThrow(
      PlatformDumpError,
    );
    expect(fs.existsSync(path.join(elsewhere, 'c1.key'))).toBe(false);
  });

  it('refuses a key directory that is itself a symbolic link', () => {
    const out = tmp();
    const elsewhere = tmp();
    fs.symlinkSync(elsewhere, path.join(out, 'secure-keys'));
    expect(() => writeSecureKeys(out, [key('a.key')])).toThrow('symbolic link');
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a key file that is a symbolic link', () => {
    const out = tmp();
    const victim = path.join(tmp(), 'victim');
    fs.writeFileSync(victim, 'untouched');
    fs.mkdirSync(path.join(out, 'secure-keys'), { recursive: true });
    fs.symlinkSync(victim, path.join(out, 'secure-keys/a.key'));
    expect(() => writeSecureKeys(out, [key('a.key')])).toThrow('symbolic link');
    expect(fs.readFileSync(victim, 'utf-8')).toBe('untouched');
  });

  it('tightens an existing file to owner-only instead of keeping its mode', () => {
    const out = tmp();
    const file = path.join(out, 'secure-keys/a.key');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    writeSecureKeys(out, [key('a.key')]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('KEY');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each(['', '.'])('refuses an empty key path (%j)', (relPath) => {
    const out = tmp();
    expect(() => writeSecureKeys(out, [key(relPath)])).toThrow('names no file');
  });
});

describe('openPlatformDump', () => {
  it('reports a malformed key as a dump error, not a crypto crash', () => {
    const framed = Buffer.concat([
      Buffer.from('FLUIPB1\0', 'binary'),
      Buffer.alloc(16),
      Buffer.from('ciphertext'),
      Buffer.alloc(16),
    ]);
    expect(() => openPlatformDump(framed, Buffer.from('short'))).toThrow(
      PlatformDumpError,
    );
  });
});
