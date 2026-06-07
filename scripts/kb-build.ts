/**
 * kb-build — compile the knowledge base into a single versioned artifact.
 *
 * Fuses the hand-authored guardrails, the generated version manifest + CLI reference,
 * and the vendored concept/CLI prose + flui.yaml schema into:
 *   - dist/kb.json  — machine artifact consumed by the assistant (system context)
 *   - dist/kb.md    — one concatenated, human-inspectable document
 * Both are committed and stamped with the compatibility matrix, so behavior is auditable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const KB = path.join(ROOT, 'src/modules/assistant/knowledge');
const SRC = path.join(KB, 'sources');
const GEN = path.join(KB, 'generated');
const DIST = path.join(KB, 'dist');

interface Section {
  id: string;
  title: string;
  source: string;
  body: string;
}

interface CompiledKb {
  kbVersion: string;
  compatibility: {
    cli: string;
    platform: { version: string; bootstrapRef: string; images: unknown };
    spec: { schemaId: string; apiVersion: string };
    sources: unknown;
  };
  guardrails: string;
  sections: Section[];
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

function loadDir(dir: string, source: string, prefix: string): Section[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const { title, body } = readFrontmatter(raw);
      const id = `${prefix}/${file.replace(/\.md$/, '')}`;
      return { id, title: title ?? id, source, body: body.trim() };
    });
}

function schemaSection(): Section[] {
  const file = path.join(SRC, 'flui-manifest.schema.json');
  if (!fs.existsSync(file)) return [];
  const json = fs.readFileSync(file, 'utf8').trim();
  return [
    {
      id: 'flui-manifest/schema',
      title: 'flui.yaml manifest — JSON Schema',
      source: 'flui-spec',
      body: ['```json', json, '```'].join('\n'),
    },
  ];
}

function cliReferenceSection(): Section[] {
  const file = path.join(GEN, 'cli-reference.generated.md');
  if (!fs.existsSync(file)) return [];
  return [
    {
      id: 'cli/reference',
      title: 'CLI reference (generated)',
      source: 'oclif-manifest',
      body: fs.readFileSync(file, 'utf8').trim(),
    },
  ];
}

function main(): void {
  const version = JSON.parse(
    fs.readFileSync(path.join(GEN, 'version-manifest.generated.json'), 'utf8'),
  ) as {
    kbVersion: string;
    cli: string;
    platform: { version: string; bootstrapRef: string; images: unknown };
    spec: { schemaId: string; apiVersion: string };
  };

  const sourcesLock = fs.existsSync(path.join(SRC, 'SOURCES.lock.json'))
    ? JSON.parse(fs.readFileSync(path.join(SRC, 'SOURCES.lock.json'), 'utf8'))
    : null;

  const guardrails = fs
    .readFileSync(path.join(SRC, 'guardrails.md'), 'utf8')
    .trim();

  const sections: Section[] = [
    ...loadDir(path.join(SRC, 'concepts'), 'flui-docs', 'concepts'),
    ...cliReferenceSection(),
    ...loadDir(path.join(SRC, 'cli-prose'), 'flui-docs', 'cli'),
    ...schemaSection(),
  ];

  const kb: CompiledKb = {
    kbVersion: version.kbVersion,
    compatibility: {
      cli: version.cli,
      platform: version.platform,
      spec: version.spec,
      sources: sourcesLock?.syncedFrom ?? null,
    },
    guardrails,
    sections,
  };

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(
    path.join(DIST, 'kb.json'),
    JSON.stringify(kb, null, 2) + '\n',
  );

  const md: string[] = [
    `# Flui Assistant knowledge base — v${kb.kbVersion}`,
    '',
    `> Compiled artifact. CLI \`${kb.compatibility.cli}\` · platform \`${kb.compatibility.platform.version}\` · spec \`${kb.compatibility.spec.apiVersion}\`. Regenerate with \`pnpm kb:build\`.`,
    '',
    '## Guardrails',
    '',
    guardrails,
  ];
  for (const s of sections) {
    md.push(
      '',
      `## ${s.title}`,
      `_(${s.id} · source: ${s.source})_`,
      '',
      s.body,
    );
  }
  fs.writeFileSync(path.join(DIST, 'kb.md'), md.join('\n') + '\n');

  console.log(
    `kb-build: v${kb.kbVersion} · ${sections.length} sections · platform ${kb.compatibility.platform.version} · spec ${kb.compatibility.spec.apiVersion}`,
  );
}

main();
