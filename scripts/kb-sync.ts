/**
 * kb-sync — materialize the KB sources from the pinned knowledge refs.
 *
 * Fetches flui-docs (concepts + CLI prose) and the flui-spec schema at the refs pinned in
 * release.config (`KNOWLEDGE_SOURCES`), into a gitignored working tree — no committed doc
 * copies, so there is no duplication to drift. A local checkout can be used instead via
 * FLUI_DOCS_DIR / FLUI_SPEC_DIR (offline dev). Only the compiled dist/kb.json is committed.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KNOWLEDGE_SOURCES } from '../src/config/release.config';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/modules/assistant/knowledge/sources');

// Precedence: explicit env path → sibling checkout → pinned remote. `FLUI_KB_SOURCE=remote`
// forces the pinned ref (use it to build the canonical, reproducible kb.json for a release).
const FORCE_REMOTE = process.env.FLUI_KB_SOURCE === 'remote';

function localDir(envVar: string, sibling: string): string | null {
  const explicit = process.env[envVar];
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (FORCE_REMOTE) return null;
  const siblingPath = path.join(ROOT, '..', sibling);
  return fs.existsSync(siblingPath) ? siblingPath : null;
}

function fetchRepoAtRef(repo: string, ref: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flui-kb-'));
  const tarball = path.join(tmp, 'repo.tar.gz');
  execFileSync(
    'curl',
    [
      '-fsSL',
      `https://codeload.github.com/${repo}/tar.gz/${ref}`,
      '-o',
      tarball,
    ],
    { stdio: 'inherit' },
  );
  execFileSync('tar', ['-xzf', tarball, '-C', tmp]);
  const dir = fs
    .readdirSync(tmp)
    .find((n) => fs.statSync(path.join(tmp, n)).isDirectory());
  if (!dir) throw new Error(`Empty archive for ${repo}@${ref}`);
  return path.join(tmp, dir);
}

function copyMarkdownDir(from: string, to: string): number {
  if (!fs.existsSync(from))
    throw new Error(`Source docs dir not found: ${from}`);
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  const files = fs.readdirSync(from).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    fs.copyFileSync(path.join(from, file), path.join(to, file));
  }
  return files.length;
}

function resolveDocsRoot(): { root: string; ref: string; origin: string } {
  const local = localDir('FLUI_DOCS_DIR', 'flui-docs');
  if (local) {
    return { root: local, ref: gitRef(local), origin: 'local' };
  }
  try {
    return {
      root: fetchRepoAtRef(
        KNOWLEDGE_SOURCES.docsRepo,
        KNOWLEDGE_SOURCES.docsRef,
      ),
      ref: KNOWLEDGE_SOURCES.docsRef,
      origin: 'remote',
    };
  } catch (error) {
    throw new Error(
      `Failed to fetch ${KNOWLEDGE_SOURCES.docsRepo}@${KNOWLEDGE_SOURCES.docsRef} (${error.message}). ` +
        `Set FLUI_DOCS_DIR to a local flui-docs checkout to sync offline.`,
    );
  }
}

// The KB carries both manifest schemas so the assistant can help author either
// kind. `flui-manifest.schema.json` keeps the CatalogApp schema (legacy name);
// `flui-application.schema.json` is the source-deploy Application schema.
const SCHEMA_FILES: Array<{ rel: string; dest: string }> = [
  {
    rel: 'schemas/catalog-app.v1beta1.json',
    dest: 'flui-manifest.schema.json',
  },
  {
    rel: 'schemas/application.v1beta1.json',
    dest: 'flui-application.schema.json',
  },
];

function syncSchema(): { ref: string; origin: string } {
  const local = localDir('FLUI_SPEC_DIR', 'flui-spec');
  if (local && fs.existsSync(path.join(local, SCHEMA_FILES[0].rel))) {
    for (const { rel, dest } of SCHEMA_FILES) {
      fs.copyFileSync(path.join(local, rel), path.join(SRC, dest));
    }
    return { ref: gitRef(local), origin: 'local' };
  }
  for (const { rel, dest } of SCHEMA_FILES) {
    execFileSync(
      'curl',
      [
        '-fsSL',
        `https://raw.githubusercontent.com/${KNOWLEDGE_SOURCES.specRepo}/${KNOWLEDGE_SOURCES.specRef}/${rel}`,
        '-o',
        path.join(SRC, dest),
      ],
      { stdio: 'inherit' },
    );
  }
  return { ref: KNOWLEDGE_SOURCES.specRef, origin: 'remote' };
}

function gitRef(dir: string): string {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function main(): void {
  fs.mkdirSync(SRC, { recursive: true });
  const docs = resolveDocsRoot();
  const docsContent = path.join(docs.root, 'src/content/docs');
  const concepts = copyMarkdownDir(
    path.join(docsContent, 'concepts'),
    path.join(SRC, 'concepts'),
  );
  const cli = copyMarkdownDir(
    path.join(docsContent, 'cli'),
    path.join(SRC, 'cli-prose'),
  );
  const spec = syncSchema();

  const lock = {
    syncedFrom: {
      docs: {
        repo: KNOWLEDGE_SOURCES.docsRepo,
        ref: docs.ref,
        origin: docs.origin,
      },
      spec: {
        repo: KNOWLEDGE_SOURCES.specRepo,
        ref: spec.ref,
        origin: spec.origin,
      },
    },
    counts: { concepts, cliProse: cli, schema: SCHEMA_FILES.length },
  };
  fs.writeFileSync(
    path.join(SRC, 'SOURCES.lock.json'),
    JSON.stringify(lock, null, 2) + '\n',
  );

  console.log(
    `kb-sync: ${concepts} concepts + ${cli} cli docs + schema (docs ${docs.origin} ${docs.ref.slice(0, 7)}, spec ${spec.origin} ${spec.ref})`,
  );
  if (docs.origin === 'local' || spec.origin === 'local') {
    console.warn(
      'kb-sync: built from a LOCAL checkout — for a committed/release kb.json run `FLUI_KB_SOURCE=remote pnpm kb` to use the pinned ref.',
    );
  }
}

main();
