/**
 * Decodes one `.tar.gz` archive of a repository commit into the `RepoSnapshot`
 * shape cartographer's detectors read — entirely in memory.
 *
 * No clone, ever: one ceiling is enforced while the archive is being
 * decompressed (`maxArchiveBytes`), one per entry as it is walked
 * (`maxFileBytes`), and two after the walk, once the whole file set is known
 * (`maxEntries`, `maxContentBytes`) — see `applyEntryCeiling`. Symlink and hardlink
 * entries are refused and counted rather than followed, and any entry whose
 * path would resolve outside the archive's own root — after the leading
 * `owner-repo-sha/` component every GitHub tarball carries is stripped —
 * rejects the whole archive rather than narrowing the read. Nothing here
 * touches the filesystem, so there is no symlink for anything to follow.
 */

import * as zlib from 'node:zlib';
import type {
  RepoSnapshot,
  RepoSnapshotLimits,
} from '../interfaces/repo-snapshot.interface';

export const DEFAULT_REPO_SNAPSHOT_LIMITS: RepoSnapshotLimits = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 20_000,
  maxContentBytes: 12 * 1024 * 1024,
  maxFileBytes: 512 * 1024,
  timeoutMs: 20_000,
};

export type ArchiveRejectReason = 'too-large' | 'unreadable' | 'rejected';

export type ArchiveScanResult =
  | { ok: true; snapshot: RepoSnapshot }
  | { ok: false; reason: ArchiveRejectReason };

const BLOCK = 512;

export async function scanArchive(
  gzipBytes: Buffer,
  limits: RepoSnapshotLimits = DEFAULT_REPO_SNAPSHOT_LIMITS,
): Promise<ArchiveScanResult> {
  const decoded = await gunzipWithCeiling(gzipBytes, limits.maxArchiveBytes);
  // `=== false`, not `!decoded.ok`: with `strictNullChecks` off (this
  // project's setting), TS only narrows a boolean-discriminated union across
  // an explicit equality check, not a negation.
  if (decoded.ok === false) return { ok: false, reason: decoded.reason };
  try {
    return parseTar(decoded.buffer, limits);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

function gunzipWithCeiling(
  gzipBytes: Buffer,
  maxBytes: number,
): Promise<
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: 'too-large' | 'unreadable' }
> {
  return new Promise((resolve) => {
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (
      result:
        | { ok: true; buffer: Buffer }
        | { ok: false; reason: 'too-large' | 'unreadable' },
    ) => {
      if (settled) return;
      settled = true;
      gunzip.removeAllListeners();
      gunzip.destroy();
      resolve(result);
    };
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish({ ok: false, reason: 'too-large' });
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on('end', () => finish({ ok: true, buffer: Buffer.concat(chunks) }));
    gunzip.on('error', () => finish({ ok: false, reason: 'unreadable' }));
    gunzip.end(gzipBytes);
  });
}

/**
 * Retention priority, mirroring the tiers `motore-corpus/tools/index-repo.js`
 * already draws between `READ_WHOLE` (small, high-truth files worth reading in
 * full) and `GREP_ONLY` (lockfiles — never worth opening whole). Lower number
 * retains first. Everything not matched by either list is tier 1, ordinary
 * source.
 *
 * This is what makes retention a function of the file, not of where the
 * archive's packer happened to place it: two tarballs of the same commit with
 * every entry in a different order must retain the same bytes.
 *
 * The same order now cuts the entry ceiling too (`applyEntryCeiling`), which
 * is what makes that promise hold above `maxEntries` as well as below it. It
 * did not, until 2026-09-08: the ceiling was a `break` mid-walk, so past
 * 20.000 entries the file *set* — not just which of them were read — was a
 * function of the packer.
 */
const HIGH_DENSITY_TIER = 0;
const SOURCE_TIER = 1;
const LOCKFILE_TIER = 2;

const HIGH_DENSITY_PATTERNS: RegExp[] = [
  /(^|\/)Dockerfile[^/]*$/i,
  /(^|\/)docker-compose[^/]*\.ya?ml$/i,
  /(^|\/)compose[^/]*\.ya?ml$/i,
  /(^|\/)package\.json$/,
  /(^|\/)go\.mod$/,
  /(^|\/)go\.work$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)requirements[^/]*\.txt$/i,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)Pipfile$/,
  /(^|\/)Gemfile$/,
  /(^|\/)composer\.json$/,
  /(^|\/)pom\.xml$/,
  /(^|\/)build\.gradle[^/]*$/,
  /\.csproj$/,
  /\.sln$/,
  /(^|\/)pnpm-workspace\.yaml$/,
  /(^|\/)turbo\.json$/,
  /(^|\/)nx\.json$/,
  /(^|\/)schema\.prisma$/,
  /(^|\/)database\.yml$/,
  /(^|\/)application\.(properties|ya?ml)$/,
  /(^|\/)\.env[^/]*$/,
  /(^|\/)Procfile$/,
  /(^|\/)settings\.py$/,
  /(^|\/)railpack\.json$/,
  /(^|\/)flui\.ya?ml$/,
  /(^|\/)\.flui\.ya?ml$/,
  /(^|\/)nixpacks\.toml$/,
];

const LOCKFILE_PATTERNS: RegExp[] = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)packages\.lock\.json$/,
];

/** Plain UTF-16 code-unit order — deterministic across locales and Node
 * versions, unlike `localeCompare`, which is exactly the property this
 * comparison exists to guarantee. */
function comparePath(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function retentionTierOf(relPath: string): number {
  if (HIGH_DENSITY_PATTERNS.some((re) => re.test(relPath)))
    return HIGH_DENSITY_TIER;
  if (LOCKFILE_PATTERNS.some((re) => re.test(relPath))) return LOCKFILE_TIER;
  return SOURCE_TIER;
}

/** A file seen during the walk, eligible for retention (not oversize), not yet decoded. */
interface RetentionCandidate {
  path: string;
  offset: number;
  size: number;
}

interface TarWalkState {
  files: string[];
  contents: Map<string, string>;
  truncated: boolean;
  contentComplete: boolean;
  bytesRetained: number;
  symlinks: number;
  oversize: number;
  other: number;
  stripPrefix: string | null;
  /** Collected during the walk, decided after it: which bytes actually get
   * decoded and kept is a property of the whole archive's file set, not of
   * the order entries happened to arrive in. */
  candidates: RetentionCandidate[];
  highDensityUnread: string[];
}

function parseTar(buf: Buffer, limits: RepoSnapshotLimits): ArchiveScanResult {
  const state: TarWalkState = {
    files: [],
    contents: new Map(),
    truncated: false,
    contentComplete: true,
    bytesRetained: 0,
    symlinks: 0,
    oversize: 0,
    other: 0,
    stripPrefix: null,
    candidates: [],
    highDensityUnread: [],
  };
  let pendingLongName: string | null = null;

  let offset = 0;
  for (;;) {
    const header = readHeader(buf, offset);
    if (!header) break;
    offset += BLOCK;
    const { typeflag, size, paddedSize, block } = header;

    const extension = readExtensionHeader(typeflag, buf, offset, size);
    if (extension.isExtension) {
      if (extension.longName) pendingLongName = extension.longName;
      offset += paddedSize;
      continue;
    }

    const name = pendingLongName ?? readNameField(block);
    pendingLongName = null;

    const entry = resolveEntry(name, typeflag, state);
    if (entry.action === 'reject') return { ok: false, reason: 'rejected' };
    if (entry.action === 'skip') {
      offset += paddedSize;
      continue;
    }

    recordFile(state, entry.path, offset, size, limits);
    offset += paddedSize;
  }

  applyEntryCeiling(state, limits);
  retainCandidates(state, buf, limits);
  return { ok: true, snapshot: buildSnapshot(state) };
}

interface TarHeader {
  typeflag: string;
  size: number;
  paddedSize: number;
  block: Buffer;
}

/** `null` at the end-of-archive marker (two zero blocks, though one suffices
 * here) or when a header claims more data than the buffer holds. */
function readHeader(buf: Buffer, offset: number): TarHeader | null {
  if (offset + BLOCK > buf.length) return null;
  const block = buf.subarray(offset, offset + BLOCK);
  if (isZeroBlock(block)) return null;
  const typeflag = String.fromCodePoint(block[156]);
  const size = readNumericField(block, 124, 12);
  const paddedSize = Math.ceil(size / BLOCK) * BLOCK;
  if (offset + BLOCK + paddedSize > buf.length) return null;
  return { typeflag, size, paddedSize, block };
}

/** `L`/`x`/`X` carry the next entry's real name; `g` is a global pax header this
 * reader has no use for. Any other typeflag is a real entry, not an extension. */
function readExtensionHeader(
  typeflag: string,
  buf: Buffer,
  offset: number,
  size: number,
): { isExtension: boolean; longName: string | null } {
  if (typeflag === 'L') {
    return {
      isExtension: true,
      longName: readCString(buf.subarray(offset, offset + size)),
    };
  }
  if (typeflag === 'x' || typeflag === 'X') {
    return {
      isExtension: true,
      longName: parsePaxPath(buf.subarray(offset, offset + size)),
    };
  }
  if (typeflag === 'g') {
    return { isExtension: true, longName: null };
  }
  return { isExtension: false, longName: null };
}

type EntryResolution =
  | { action: 'file'; path: string }
  | { action: 'skip' }
  | { action: 'reject' };

/**
 * Strips the leading `owner-repo-sha/` component every GitHub tarball carries,
 * validates what remains, and classifies the typeflag — all in one pass so
 * the walk above stays a flat dispatch. `skip` covers the root entry itself,
 * a directory, and a symlink/hardlink/other typeflag (counted before
 * skipping); `reject` refuses the whole archive: a second top-level
 * component, or a path escaping the root.
 */
function resolveEntry(
  rawName: string,
  typeflag: string,
  state: TarWalkState,
): EntryResolution {
  let name = rawName;
  while (name.endsWith('/')) name = name.slice(0, -1);
  if (name.length === 0) return { action: 'skip' };

  const firstSlash = name.indexOf('/');
  const topComponent = firstSlash === -1 ? name : name.slice(0, firstSlash);
  if (state.stripPrefix === null) {
    state.stripPrefix = topComponent;
  } else if (topComponent !== state.stripPrefix) {
    return { action: 'reject' };
  }
  const relPath = firstSlash === -1 ? '' : name.slice(firstSlash + 1);
  if (relPath === '') return { action: 'skip' };
  if (isEscapingPath(relPath)) return { action: 'reject' };

  if (typeflag === '5') return { action: 'skip' }; // directory: implied by its files
  if (typeflag === '2' || typeflag === '1') {
    state.symlinks += 1; // symlink/hardlink: refused on purpose, never followed
    return { action: 'skip' };
  }
  if (typeflag !== '0' && typeflag !== '\0') {
    state.other += 1;
    return { action: 'skip' };
  }
  return { action: 'file', path: relPath };
}

/**
 * Records that a file exists and, unless it is individually oversize (a
 * per-file decision, independent of everything else in the archive), makes it
 * a candidate for retention. Deciding *which* candidates are actually decoded
 * happens once in `retainCandidates`, after the whole archive has been walked
 * and every candidate is known — retaining as each entry is seen is exactly
 * the arrival-order dependency this reader must not have.
 */
function recordFile(
  state: TarWalkState,
  relPath: string,
  offset: number,
  size: number,
  limits: RepoSnapshotLimits,
): void {
  state.files.push(relPath);
  if (size > limits.maxFileBytes) {
    state.oversize += 1;
    state.contentComplete = false;
    return;
  }
  state.candidates.push({ path: relPath, offset, size });
}

/**
 * Cuts the file set down to `maxEntries` — after the whole archive has been
 * walked, and by the same (tier, path) order retention uses.
 *
 * This used to be a `break` in the middle of the walk, which meant the entry
 * ceiling was the one limit still enforced in arrival order: past 20.000
 * entries, *which* files a repository was said to contain — and therefore the
 * whole map built on top of them — was a function of how the `.tar.gz` had
 * been packed, not of the commit. The section header above promised the
 * opposite ("two tarballs of the same commit with every entry in a different
 * order must retain the same bytes") and was true only below the ceiling. The
 * corpus could not see it: its largest repository has 15.301 files, so nothing
 * measured on those 81 archives ever crossed the line. Verified with a small
 * `maxEntries` instead, which is where the boundary is reachable.
 *
 * The walk now always runs to the end of the buffer. That costs paths and
 * offsets, not content, and it is bounded by a ceiling already enforced
 * upstream: the buffer is at most `maxArchiveBytes`, so it holds at most
 * `maxArchiveBytes / 512` headers.
 */
function applyEntryCeiling(
  state: TarWalkState,
  limits: RepoSnapshotLimits,
): void {
  if (state.files.length <= limits.maxEntries) return;
  const kept = new Set(
    [...state.files].sort(compareRetention).slice(0, limits.maxEntries),
  );
  state.files = state.files.filter((file) => kept.has(file));
  state.candidates = state.candidates.filter((candidate) =>
    kept.has(candidate.path),
  );
  state.truncated = true;
  state.contentComplete = false;
}

/** Priority tier first, path within a tier. The one order both ceilings cut
 * along, so what a truncated archive lists and what it retains are decided the
 * same way. */
function compareRetention(a: string, b: string): number {
  const tierDiff = retentionTierOf(a) - retentionTierOf(b);
  return tierDiff === 0 ? comparePath(a, b) : tierDiff;
}

/**
 * Decides which candidates fit under `maxContentBytes` and decodes exactly
 * those — by declared priority tier first, and by path within a tier, never
 * by the position the archive happened to place the entry at. A high-density
 * file that still does not fit (the tier itself exceeds the cap) is named in
 * `highDensityUnread` rather than left indistinguishable from an ordinary
 * source file that was cut.
 */
function retainCandidates(
  state: TarWalkState,
  buf: Buffer,
  limits: RepoSnapshotLimits,
): void {
  const ordered = [...state.candidates].sort((a, b) =>
    compareRetention(a.path, b.path),
  );

  for (const candidate of ordered) {
    const remaining = limits.maxContentBytes - state.bytesRetained;
    if (candidate.size <= remaining) {
      state.contents.set(
        candidate.path,
        buf
          .subarray(candidate.offset, candidate.offset + candidate.size)
          .toString('utf8'),
      );
      state.bytesRetained += candidate.size;
    } else {
      state.contentComplete = false;
      if (retentionTierOf(candidate.path) === HIGH_DENSITY_TIER)
        state.highDensityUnread.push(candidate.path);
    }
  }
}

/**
 * Shallowest first, then path — the order `RepoSnapshot.files` promises.
 * Retention already stopped depending on archive order; this closes the same
 * gap for *listing* order, which matters because cartographer breaks ties
 * (which of several files declaring the same signal is "the" source) by
 * scan order. Left as arrival order, two archives that retain the identical
 * set of files could still hand cartographer that set in a different
 * sequence and get two different tie-break winners — measured on
 * `django-lithium`: `psycopg` declared in both `pyproject.toml` and
 * `requirements.txt`, `source:` flipping between the two under nothing but a
 * different pack order. Sorting here, once, fixes it for every consumer
 * instead of pushing the fix into cartographer's own tie-breaks one at a
 * time.
 */
function depthOf(relPath: string): number {
  return relPath.split('/').length - 1;
}

function compareListing(a: string, b: string): number {
  const depthDiff = depthOf(a) - depthOf(b);
  if (depthDiff !== 0) return depthDiff;
  return comparePath(a, b);
}

function buildSnapshot(state: TarWalkState): RepoSnapshot {
  const sourceExtensions = loadSourceExtensions();
  const files = [...state.files].sort(compareListing);
  return {
    files,
    truncated: state.truncated,
    read: (file: string) => state.contents.get(file) ?? null,
    sources: () =>
      files
        .filter(
          (file) =>
            sourceExtensions.has(extensionOf(file)) && state.contents.has(file),
        )
        .map((path) => ({ path, content: state.contents.get(path) as string })),
    skipped: {
      symlinks: state.symlinks,
      oversize: state.oversize,
      other: state.other,
    },
    contentComplete: state.contentComplete,
    bytesRead: state.bytesRetained,
    highDensityUnread: state.highDensityUnread,
  };
}

let cachedSourceExtensions: Set<string> | null = null;
function loadSourceExtensions(): Set<string> {
  if (!cachedSourceExtensions) {
    // Lazy require: keeps this module loadable in isolation (unit tests that
    // never touch cartographer) and sidesteps any import-order concerns.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cartographer = require('@flui-cloud/cartographer') as {
      SOURCE_EXTENSIONS: Set<string>;
    };
    cachedSourceExtensions = cartographer.SOURCE_EXTENSIONS;
  }
  return cachedSourceExtensions;
}

function extensionOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot);
}

function isEscapingPath(relPath: string): boolean {
  if (relPath.startsWith('/')) return true;
  return relPath
    .split('/')
    .some((segment) => segment === '..' || segment === '');
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function readCString(buf: Buffer): string {
  const idx = buf.indexOf(0);
  return (idx === -1 ? buf : buf.subarray(0, idx)).toString('utf8');
}

function readNameField(header: Buffer): string {
  const magic = header.subarray(257, 263).toString('ascii');
  const name = readCString(header.subarray(0, 100));
  if (magic.startsWith('ustar')) {
    const prefix = readCString(header.subarray(345, 500));
    if (prefix) return `${prefix}/${name}`;
  }
  return name;
}

function readNumericField(buf: Buffer, offset: number, length: number): number {
  const slice = buf.subarray(offset, offset + length);
  if (slice.length > 0 && (slice[0] & 0x80) !== 0) {
    // GNU base-256 encoding, for a size too large to fit in octal ASCII.
    let value = BigInt(slice[0] & 0x7f);
    for (let i = 1; i < slice.length; i++)
      value = (value << 8n) | BigInt(slice[i]);
    return Number(value);
  }
  const raw = slice.toString('ascii');
  const nul = raw.indexOf('\0');
  const text = (nul === -1 ? raw : raw.slice(0, nul)).trim();
  if (!text) return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parsePaxPath(content: Buffer): string | null {
  let offset = 0;
  while (offset < content.length) {
    const spaceIdx = content.indexOf(0x20, offset);
    if (spaceIdx === -1) break;
    const lenText = content.subarray(offset, spaceIdx).toString('ascii');
    const len = Number.parseInt(lenText, 10);
    if (!Number.isFinite(len) || len <= 0 || offset + len > content.length)
      break;
    const record = content.subarray(offset, offset + len).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1) {
      const key = record.slice(lenText.length + 1, eq);
      if (key === 'path') {
        // Record ends with '\n'; drop it.
        return record.slice(eq + 1, len - 1);
      }
    }
    offset += len;
  }
  return null;
}
