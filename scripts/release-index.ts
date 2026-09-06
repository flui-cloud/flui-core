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
 * release tag's own commit date. Only `notes` is authored.
 *
 *   pnpm release:index --notes "Cluster rebuild" --notes "Backup quick setup"
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RELEASE } from '../src/config/release.config';
import { compareVersions } from '../src/modules/platform-updates/utils/version-compare';

const ROOT = path.resolve(__dirname, '..');
const INDEX_FILE = path.join(ROOT, 'releases.json');
const MIGRATIONS_INDEX = 'src/migrations/index.ts';

interface ReleaseEntry {
  version: string;
  publishedAt: string;
  bootstrapRef: string;
  images: Record<string, string>;
  notes: string[];
  migrations: number;
  requiresBootstrap: boolean;
  minFrom?: string;
}

interface ReleaseIndex {
  schemaVersion: number;
  releases: ReleaseEntry[];
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

function main(): void {
  const index = readIndex();
  const others = index.releases.filter((r) => r.version !== RELEASE.version);
  const existing = index.releases.find((r) => r.version === RELEASE.version);

  const previous = previousVersion(index);
  const previousEntry = others.find((r) => r.version === previous) ?? null;

  const notes = flagValues('notes');
  const minFrom = flagValues('min-from')[0] ?? existing?.minFrom;

  const entry: ReleaseEntry = {
    version: RELEASE.version,
    publishedAt: existing?.publishedAt ?? publishedAt(RELEASE.version),
    bootstrapRef: RELEASE.bootstrapRef,
    images: { ...RELEASE.images },
    notes: notes.length > 0 ? notes : (existing?.notes ?? []),
    migrations: migrationsSince(previous),
    // Unknown for a release with no predecessor in the index: an entry that
    // cannot be compared claims nothing rather than claiming "no change".
    requiresBootstrap: previousEntry
      ? previousEntry.bootstrapRef !== RELEASE.bootstrapRef
      : false,
    ...(minFrom ? { minFrom } : {}),
  };

  const releases = [...others, entry].sort(
    (a, b) => compareVersions(b.version, a.version) ?? 0,
  );
  fs.writeFileSync(
    INDEX_FILE,
    `${JSON.stringify({ schemaVersion: index.schemaVersion ?? 1, releases }, null, 2)}\n`,
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

main();
