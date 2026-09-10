/**
 * A minimal, dependency-free `.tar.gz` writer used only by this piece's own
 * tests — the mirror image of the reader in `repo-archive-scan.util.ts`, kept
 * beside it so the two can be checked against each other without a `tar`
 * dependency this repository does not otherwise need.
 */

import * as zlib from 'node:zlib';

export interface TarFixtureEntry {
  path: string;
  content?: string;
  type?: 'file' | 'dir' | 'symlink' | 'hardlink';
  linkTarget?: string;
}

const BLOCK = 512;

export function buildTarGz(entries: TarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(...buildEntryBlocks(entry));
  }
  blocks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return zlib.gzipSync(Buffer.concat(blocks));
}

function buildEntryBlocks(entry: TarFixtureEntry): Buffer[] {
  const type = entry.type ?? 'file';
  const isDir = type === 'dir';
  const isLink = type === 'symlink' || type === 'hardlink';
  const name =
    isDir && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path;
  const contentBuf = Buffer.from(entry.content ?? '', 'utf8');

  const header = Buffer.alloc(BLOCK);
  const { prefix, suffix } = splitUstarName(name);
  writeField(header, suffix, 0, 100);
  if (prefix) writeField(header, prefix, 345, 155);
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, isDir || isLink ? 0 : contentBuf.length, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156); // checksum field reads as spaces while summing
  let typeflag = '0';
  if (isDir) typeflag = '5';
  else if (type === 'symlink') typeflag = '2';
  else if (type === 'hardlink') typeflag = '1';
  header[156] = typeflag.codePointAt(0) as number;
  if (isLink && entry.linkTarget)
    writeField(header, entry.linkTarget, 157, 100);
  writeField(header, 'ustar\0', 257, 6);
  writeField(header, '00', 263, 2);

  let sum = 0;
  for (const byte of header) sum += byte;
  writeField(header, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);

  const blocks = [header];
  if (type === 'file') {
    blocks.push(contentBuf);
    const pad = (BLOCK - (contentBuf.length % BLOCK)) % BLOCK;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  return blocks;
}

/** POSIX ustar's own answer to a name over 100 bytes: split at the rightmost
 * `/` that leaves the suffix within 100 bytes and the prefix within 155. */
function splitUstarName(name: string): { prefix: string; suffix: string } {
  if (Buffer.byteLength(name, 'utf8') <= 100)
    return { prefix: '', suffix: name };
  const segments = name.split('/');
  for (let cut = 1; cut < segments.length; cut++) {
    const prefix = segments.slice(0, cut).join('/');
    const suffix = segments.slice(cut).join('/');
    if (
      Buffer.byteLength(suffix, 'utf8') <= 100 &&
      Buffer.byteLength(prefix, 'utf8') <= 155
    ) {
      return { prefix, suffix };
    }
  }
  return { prefix: '', suffix: name };
}

function writeField(
  buf: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  buf.write(value, offset, length, 'utf8');
}

function writeOctal(
  buf: Buffer,
  value: number,
  offset: number,
  length: number,
): void {
  const digits = value.toString(8).padStart(length - 1, '0');
  buf.write(digits, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}
