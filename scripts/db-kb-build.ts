/**
 * db-kb-build — compile the database console's PostgreSQL copilot knowledge base.
 *
 * Unlike the Flui Assistant KB (vendored + generated + version-bound), this corpus is small,
 * hand-authored, and version-agnostic: the live server version is injected as a binding at
 * runtime, not branched here. Sources under knowledge/sources compile into one committed,
 * human-auditable artifact (dist/kb.json) that the copilot injects whole.
 *
 *   pnpm db:kb:build
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const KB = path.join(ROOT, 'src/modules/database-console/knowledge');
const SRC = path.join(KB, 'sources');
const DIST = path.join(KB, 'dist');

interface Section {
  id: string;
  title: string;
  body: string;
}

function readFrontmatter(raw: string): { title?: string; body: string } {
  if (!raw.startsWith('---')) return { body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { body: raw };
  const header = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\s*\n/, '');
  const titleLine = header
    .split('\n')
    .find((l) => l.trim().startsWith('title:'));
  const title = titleLine
    ?.slice(titleLine.indexOf(':') + 1)
    .trim()
    .replace(/^["']|["']$/g, '');
  return { title, body };
}

function loadDir(dir: string, prefix: string): Section[] {
  if (!fs.existsSync(dir)) return [];
  return (
    fs
      .readdirSync(dir)
      // `_`-prefixed files (e.g. _guardrails.md) are not corpus sections.
      .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
      .sort()
      .map((file) => {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        const { title, body } = readFrontmatter(raw);
        const id = `${prefix}/${file.replace(/\.md$/, '')}`;
        return { id, title: title ?? id, body: body.trim() };
      })
  );
}

// One curated corpus per engine. The folder name under sources/ is the dialect tag
// and the dist filename: sources/<engine>/*.md → dist/<engine>.kb.json.
const ENGINES: { engine: string; dialect: string }[] = [
  { engine: 'postgres', dialect: 'postgres' },
  { engine: 'mariadb', dialect: 'mysql' },
  { engine: 'redis', dialect: 'redis' },
];

function stripFrontmatter(raw: string): string {
  return raw.trim().replace(/^---[\s\S]*?\n---\s*\n/, '');
}

function main(): void {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ) as { version?: string };

  // Shared, engine-neutral SQL guardrails; an engine may override with sources/<engine>/_guardrails.md
  // (e.g. Redis, whose contract is "a command", not "a SQL query").
  const sharedGuardrails = stripFrontmatter(
    fs.readFileSync(path.join(SRC, 'guardrails.md'), 'utf8'),
  );

  fs.mkdirSync(DIST, { recursive: true });

  for (const { engine, dialect } of ENGINES) {
    const overridePath = path.join(SRC, engine, '_guardrails.md');
    const guardrails = fs.existsSync(overridePath)
      ? stripFrontmatter(fs.readFileSync(overridePath, 'utf8'))
      : sharedGuardrails;
    const sections = loadDir(path.join(SRC, engine), engine);
    const kb = {
      kbVersion: pkg.version ?? '0.0.0',
      dialect,
      guardrails,
      sections,
    };
    fs.writeFileSync(
      path.join(DIST, `${engine}.kb.json`),
      JSON.stringify(kb, null, 2) + '\n',
    );
    const tokens = Math.round(
      (guardrails.length + sections.reduce((n, s) => n + s.body.length, 0)) / 4,
    );
    console.log(
      `db-kb-build: ${engine} · ${sections.length} sections · ~${tokens} tokens (whole-inject)`,
    );
  }
}

main();
