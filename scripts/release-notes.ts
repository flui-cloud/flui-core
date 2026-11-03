/**
 * release-notes — renders the GitHub release page of a version from its entry
 * in `releases.json`, so the notes people read on GitHub are the ones an
 * installation reads, written once with `pnpm release:index --notes`.
 *
 *   pnpm release:notes --tag v0.14.0 --out release-notes.md
 *
 * Runs in CI after `publish-release-index` (.github/workflows/docker-publish.yml).
 * Run it by hand, then `gh release edit`, after adding notes to a published entry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RELEASE } from '../src/config/release.config';
import { ReleaseEntry, ReleaseIndex } from './release-index';

const ROOT = path.resolve(__dirname, '..');
const INDEX_FILE = path.join(ROOT, 'releases.json');
const DOCS = 'https://docs.flui.cloud';

const IMAGES: Record<string, { label: string; image: string }> = {
  fluiApi: { label: 'API', image: 'ghcr.io/flui-cloud/core' },
  fluiWeb: { label: 'Dashboard', image: 'ghcr.io/flui-cloud/dashboard' },
  fluiAuthz: { label: 'Sign-in relay', image: 'ghcr.io/flui-cloud/flui-authz' },
};

export function renderReleaseNotes(entry: ReleaseEntry): string {
  const lines: string[] = [
    'Flui is an open source PaaS for European cloud providers and your own Ubuntu servers.',
    '',
  ];

  if (entry.notes.length > 0) {
    lines.push("## What's new", '', ...entry.notes.map((n) => `- ${n}`), '');
  }

  lines.push(
    '## Install or upgrade',
    '',
    `New here? Start with [get Flui running](${DOCS}/tasks/get-flui-running/). To update an existing installation:`,
    '',
    '```bash',
    `flui env upgrade --to ${entry.version}`,
    '```',
    '',
    '## Components',
    '',
    '| Component | Version |',
    '| --- | --- |',
  );

  for (const [key, tag] of Object.entries(entry.images)) {
    const known = IMAGES[key];
    lines.push(
      known
        ? `| ${known.label} | \`${known.image}:${tag}\` |`
        : `| ${key} | \`${tag}\` |`,
    );
  }
  if (entry.k3s) lines.push(`| K3s | \`${entry.k3s.version}\` |`);
  lines.push('');

  return lines.join('\n');
}

function flagValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(): void {
  const version = (flagValue('tag') ?? RELEASE.version).replace(/^v/, '');
  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) as ReleaseIndex;
  const entry = index.releases.find((r) => r.version === version);
  if (!entry) {
    throw new Error(
      `releases.json has no entry for ${version}. Run pnpm release:index first.`,
    );
  }

  const notes = renderReleaseNotes(entry);
  const out = flagValue('out');
  if (out) fs.writeFileSync(out, notes);
  else process.stdout.write(notes);
}

if (require.main === module) main();
