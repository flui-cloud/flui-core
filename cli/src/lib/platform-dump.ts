import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';

/** FLUIPB1\0 + iv(16) + ciphertext + gcm tag(16) — written by PlatformBackupService. */
const DUMP_MAGIC = Buffer.from('FLUIPB1\0', 'binary');

export class PlatformDumpError extends Error {}

/** Opens a platform dump with the key its bundle carries, and ungzips it. */
export function openPlatformDump(framed: Buffer, dek: Buffer): Buffer {
  if (!framed.subarray(0, DUMP_MAGIC.length).equals(DUMP_MAGIC)) {
    throw new PlatformDumpError(
      'That file is not a Flui platform dump (missing the FLUIPB1 header).',
    );
  }
  const ivStart = DUMP_MAGIC.length;
  const iv = framed.subarray(ivStart, ivStart + 16);
  const tag = framed.subarray(-16);
  const ciphertext = framed.subarray(ivStart + 16, -16);

  let decipher: crypto.DecipherGCM;
  try {
    decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(tag);
  } catch (err) {
    throw new PlatformDumpError(
      `The bundle's key cannot open a platform dump — the bundle is damaged or ` +
        `not a platform key bundle: ${(err as Error).message}`,
    );
  }
  try {
    const gz = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return gunzipSync(gz);
  } catch (err) {
    throw new PlatformDumpError(
      `The dump did not decrypt with this bundle's key — bundle and dump are ` +
        `from different runs, or the file is truncated: ${(err as Error).message}`,
    );
  }
}

export interface SecureKeyFile {
  relPath: string;
  mode: string;
  contentBase64: string;
}

/**
 * Writes the API's key directory, as the bundle recorded it, under
 * `<outDir>/secure-keys`. A recorded path that would leave that directory is
 * refused, and so is a symbolic link anywhere between the key directory and
 * the file: the bundle is trusted to be ours, the file system is not a place
 * to find out otherwise.
 */
export function writeSecureKeys(
  outDir: string,
  files: SecureKeyFile[],
): string[] {
  const root = path.resolve(outDir, 'secure-keys');
  const written: string[] = [];
  for (const file of files) {
    const target = path.resolve(root, file.relPath ?? '');
    if (target === root) {
      throw new PlatformDumpError(
        `Refusing a key file whose recorded path names no file: ${JSON.stringify(file.relPath)}`,
      );
    }
    if (!target.startsWith(root + path.sep)) {
      throw new PlatformDumpError(
        `Refusing a key file outside the key directory: ${file.relPath}`,
      );
    }
    refuseSymlinks(root, target);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const recorded = Number.parseInt(file.mode, 8);
    const mode = Number.isFinite(recorded) ? recorded & 0o600 : 0o600;
    fs.writeFileSync(target, Buffer.from(file.contentBase64, 'base64'), {
      mode,
      flag: 'w',
    });
    fs.chmodSync(target, mode);
    written.push(target);
  }
  return written;
}

function refuseSymlinks(root: string, target: string): void {
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep)]) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new PlatformDumpError(
        `Refusing to write a key file through a symbolic link: ${current}`,
      );
    }
  }
}
