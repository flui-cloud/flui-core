/**
 * release-index — publishes `RELEASE` as an entry in `releases.json`.
 *
 * The release manifest an installation reads is NOT a second place to write
 * versions down: it is `src/config/release.config.ts` in enumerable form. An
 * installed API only knows the release it was compiled as, so something outside
 * the artefact has to list what exists — this generates that list from the same
 * constant the API and the CLI already compile, and `release-index.spec.ts`
 * fails the build if the two ever disagree.
 *
 * Three of the four fields that are not in RELEASE are derived, not invented:
 * `migrations` from the migrations added since the previous release's tag,
 * `requiresBootstrap` from a changed `bootstrapRef`, `publishedAt` from the
 * release tag's own commit date. Only `notes` is authored, and it is optional —
 * an entry with none still publishes; there is nothing worth templating out of
 * a commit log; good release copy is written by a person, later, with:
 *
 *   pnpm release:index --notes "Cluster rebuild" --notes "Backup quick setup"
 *
 * Pushing a tag matching `RELEASE.version` runs this in CI
 * (.github/workflows/docker-publish.yml, job `publish-release-index`), which
 * passes `--verify-tag` so a forgotten version bump fails loudly instead of
 * publishing an entry for the wrong release.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RELEASE, ReleaseManifest } from '../src/config/release.config';
import { compareVersions } from '../src/modules/platform-updates/utils/version-compare';

const ROOT = path.resolve(__dirname, '..');
const INDEX_FILE = path.join(ROOT, 'releases.json');
const MIGRATIONS_INDEX = 'src/migrations/index.ts';
export const RELEASE_INDEX_SCHEMA_VERSION = 2;

type ManifestSet = 'control' | 'workload' | 'common';
const MANIFEST_SETS: ManifestSet[] = ['control', 'workload', 'common'];
const BOOTSTRAP_DIR =
  process.env.BOOTSTRAP_SCRIPTS_DIR ??
  path.resolve(ROOT, '../bootstrap-scripts');

export interface ReleaseEntry {
  version: string;
  publishedAt: string;
  bootstrapRef: string;
  images: Record<string, string>;
  notes: string[];
  migrations: number;
  requiresBootstrap: boolean;
  minFrom?: string;
  k3s?: { version: string };
  systemComponents?: Record<string, string>;
  manifestSets?: ManifestSet[];
}

export interface ReleaseIndex {
  schemaVersion: number;
  releases: ReleaseEntry[];
}

function flagValue(name: string): string | undefined {
  const values = flagValues(name);
  return values[0];
}

function flagValues(name: string): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[++i]);
  }
  return out;
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function readIndex(): ReleaseIndex {
  if (!fs.existsSync(INDEX_FILE)) return { schemaVersion: 1, releases: [] };
  const parsed = JSON.parse(
    fs.readFileSync(INDEX_FILE, 'utf8'),
  ) as ReleaseIndex;
  if (!Array.isArray(parsed.releases)) {
    throw new Error(`${INDEX_FILE} carries no releases array`);
  }
  return parsed;
}

/** Every migration is one import line, so the imports are the count. */
function countMigrations(source: string): number {
  return (source.match(/from '\.\/\d+-/g) ?? []).length;
}

/**
 * The release this one follows: the newest entry already in the index below the
 * current version, or — seeding an empty index — the newest release tag in the
 * checkout. Without it there is nothing to diff against, and "how many
 * migrations" has no answer rather than a large one.
 */
function previousVersion(index: ReleaseIndex): string | null {
  const fromIndex = index.releases.map((r) => r.version);
  const fromTags = (git(['tag', '--list', 'v*']) ?? '')
    .split('\n')
    .map((t) => t.trim().replace(/^v/, ''))
    .filter(Boolean);
  const candidates = [...new Set([...fromIndex, ...fromTags])]
    .filter((v) => compareVersions(v, RELEASE.version) === -1)
    .sort((a, b) => compareVersions(b, a) ?? 0);
  return candidates[0] ?? null;
}

/**
 * How many migrations this release adds. Counted against the previous release,
 * because a count is only meaningful relative to what you are coming from — and
 * a wrong one here is a promise about the database nobody can keep.
 *
 * Run this at the release commit: on a branch ahead of the tag it also counts
 * the migrations that have not shipped yet.
 */
function migrationsSince(previous: string | null): number {
  const override = flagValues('migrations')[0];
  if (override !== undefined) return Number.parseInt(override, 10);
  const current = countMigrations(
    fs.readFileSync(path.join(ROOT, MIGRATIONS_INDEX), 'utf8'),
  );
  if (!previous) {
    throw new Error(
      'Cannot count migrations: no earlier release is known, from the index or ' +
        'from a tag. Pass --migrations <n> for this first entry.',
    );
  }

  const tag = `v${previous}`;
  const before = git(['show', `${tag}:${MIGRATIONS_INDEX}`]);
  if (before === null) {
    throw new Error(
      `Cannot count migrations: tag ${tag} is not in this checkout. ` +
        `Fetch the tags, or pass --migrations <n> if you know the number.`,
    );
  }
  return current - countMigrations(before);
}

function publishedAt(version: string): string {
  const tagged = git(['log', '-1', '--format=%cI', `v${version}`]);
  if (tagged) return tagged;
  console.warn(
    `warning: tag v${version} not found — stamping publishedAt with the current time.`,
  );
  return new Date().toISOString();
}

/**
 * Refuses to publish an entry for a release nobody meant to cut: the tag is
 * the trigger (a human decided "this commit is a release" by naming it), so if
 * `RELEASE.version` was not bumped to match, the entry would describe the wrong
 * release under the right tag — worse than no entry at all, because an
 * installation would trust it.
 */
function verifyTag(): void {
  const tag = flagValue('verify-tag');
  if (!tag) return;
  const tagVersion = tag.replace(/^v/, '');
  if (tagVersion !== RELEASE.version) {
    throw new Error(
      `Tag ${tag} does not match RELEASE.version (${RELEASE.version}) in ` +
        `src/config/release.config.ts. Bump it before tagging.`,
    );
  }
}

/**
 * The manifest sets whose files differ between two bootstrap refs, read from a
 * checkout of the bootstrap repository; null when it cannot be told.
 */
export function changedManifestSets(
  repo: string,
  from: string,
  to: string,
): ManifestSet[] | null {
  try {
    const out = execFileSync(
      'git',
      [
        '-C',
        repo,
        'diff',
        '--name-only',
        from,
        to,
        '--',
        ...MANIFEST_SETS.map((set) => `manifests/${set}`),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const changed = new Set(
      out
        .split('\n')
        .map((line) => /^manifests\/([^/]+)\//.exec(line.trim())?.[1])
        .filter(Boolean),
    );
    return MANIFEST_SETS.filter((set) => changed.has(set));
  } catch {
    return null;
  }
}

export function buildEntry(input: {
  release: ReleaseManifest;
  existing: ReleaseEntry | null;
  previousEntry: ReleaseEntry | null;
  publishedAt: string;
  migrations: number;
  notes: string[];
  minFrom?: string;
  manifestSets?: ManifestSet[] | null;
}): ReleaseEntry {
  const { release, existing, previousEntry } = input;
  const requiresBootstrap = previousEntry
    ? previousEntry.bootstrapRef !== release.bootstrapRef
    : true;
  const manifestSets =
    input.manifestSets ??
    existing?.manifestSets ??
    (requiresBootstrap ? [...MANIFEST_SETS] : []);
  return {
    version: release.version,
    publishedAt: input.publishedAt,
    bootstrapRef: release.bootstrapRef,
    images: { ...release.images },
    notes: input.notes.length > 0 ? input.notes : (existing?.notes ?? []),
    migrations: input.migrations,
    // With no predecessor in the index there is nothing to compare against —
    // which happens when a release was tagged but never indexed. `false` is not
    // the neutral answer it looks like: it is read as "no bootstrap change" and
    // clears the blocker that sends the operator to the CLI, so an installation
    // would take the new images and never re-run the manifests. Unknown
    // therefore resolves to `true`: running the bootstrap again costs a
    // reinstall, skipping it costs the release.
    requiresBootstrap,
    ...(input.minFrom ? { minFrom: input.minFrom } : {}),
    k3s: { version: release.k3s.version },
    systemComponents: { ...release.systemComponents },
    manifestSets: [...manifestSets],
  };
}

/** Entries of other releases are kept verbatim: a schema-1 entry stays one. */
export function buildIndex(
  index: ReleaseIndex,
  entry: ReleaseEntry,
): ReleaseIndex {
  const others = index.releases.filter((r) => r.version !== entry.version);
  const releases = [...others, entry].sort(
    (a, b) => compareVersions(b.version, a.version) ?? 0,
  );
  return { schemaVersion: RELEASE_INDEX_SCHEMA_VERSION, releases };
}

function main(): void {
  verifyTag();
  const index = readIndex();
  const others = index.releases.filter((r) => r.version !== RELEASE.version);
  const existing =
    index.releases.find((r) => r.version === RELEASE.version) ?? null;

  const previous = previousVersion(index);
  const previousEntry = others.find((r) => r.version === previous) ?? null;

  const entry = buildEntry({
    release: RELEASE,
    existing,
    previousEntry,
    publishedAt: existing?.publishedAt ?? publishedAt(RELEASE.version),
    migrations: migrationsSince(previous),
    notes: flagValues('notes'),
    minFrom: flagValues('min-from')[0] ?? existing?.minFrom,
    manifestSets: !previousEntry
      ? null
      : previousEntry.bootstrapRef === RELEASE.bootstrapRef
        ? []
        : fs.existsSync(BOOTSTRAP_DIR)
          ? changedManifestSets(
              BOOTSTRAP_DIR,
              previousEntry.bootstrapRef,
              RELEASE.bootstrapRef,
            )
          : null,
  });

  fs.writeFileSync(
    INDEX_FILE,
    `${JSON.stringify(buildIndex(index, entry), null, 2)}\n`,
  );

  console.log(
    `${existing ? 'Updated' : 'Added'} ${entry.version} in releases.json — ` +
      `bootstrap ${entry.bootstrapRef}, ${entry.migrations} migration(s), ` +
      `requiresBootstrap=${entry.requiresBootstrap}, ${entry.notes.length} note(s).`,
  );
  if (entry.notes.length === 0) {
    console.warn(
      'warning: no release notes. Pass --notes "..." once per line before publishing.',
    );
  }
}

if (require.main === module) main();
