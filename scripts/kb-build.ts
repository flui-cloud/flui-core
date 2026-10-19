/**
 * kb-build — compile the knowledge base into a single versioned artifact.
 *
 * Fuses the hand-authored guardrails and pages (capabilities), the generated version
 * manifest, CLI reference and dashboard map, and the synced docs (concepts, task guides,
 * CLI prose; MDX cleaned by kb-mdx) + flui.yaml schemas into:
 *   - dist/kb.json  — machine artifact consumed by the assistant (system context)
 *   - dist/kb.md    — one concatenated, human-inspectable document
 * Both are committed and stamped with the compatibility matrix, so behavior is auditable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { cleanMdx, leftoverComponents, stripHtmlComments } from './kb-mdx';

const ROOT = path.resolve(__dirname, '..');
const KB = path.join(ROOT, 'src/modules/assistant/knowledge');
const SRC = path.join(KB, 'sources');
const GEN = path.join(KB, 'generated');
const DIST = path.join(KB, 'dist');
const AUTHORED = path.join(SRC, 'authored');

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
    spec: {
      application: { schemaId: string; apiVersion: string };
      catalogApp: { schemaId: string; apiVersion: string };
    };
    sources: unknown;
  };
  guardrails: string;
  sections: Section[];
}

function readFrontmatter(raw: string): {
  title?: string;
  draft: boolean;
  body: string;
} {
  if (!raw.startsWith('---')) return { draft: false, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { draft: false, body: raw };
  const header = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\s*\n/, '');
  const field = (name: string): string | undefined => {
    const line = header.split('\n').find((l) => l.startsWith(`${name}:`));
    return line
      ?.slice(line.indexOf(':') + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  };
  return { title: field('title'), draft: field('draft') === 'true', body };
}

const skippedDrafts: string[] = [];
const markupProblems: string[] = [];

/**
 * Draft pages are not published on docs.flui.cloud, so they stay out: the
 * assistant would link a page that 404s and repeat text the author has not
 * released.
 */
function loadDir(dir: string, source: string, prefix: string): Section[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.mdx?$/.test(f))
    .sort()
    .flatMap((file) => {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const { title, draft, body } = readFrontmatter(raw);
      const id = `${prefix}/${file.replace(/\.mdx?$/, '')}`;
      if (draft) {
        skippedDrafts.push(id);
        return [];
      }
      const text = file.endsWith('.mdx')
        ? cleanMdx(body)
        : stripHtmlComments(body).trim();
      for (const tag of new Set(leftoverComponents(text))) {
        markupProblems.push(`${id}: ${tag}`);
      }
      return [{ id, title: title ?? id, source, body: text }];
    });
}

function requiredPage(
  file: string,
  id: string,
  source: string,
  hint: string,
): Section {
  if (!fs.existsSync(file)) {
    throw new Error(
      `kb-build: ${path.relative(ROOT, file)} is missing — ${hint}`,
    );
  }
  const { title, body } = readFrontmatter(fs.readFileSync(file, 'utf8'));
  const text = stripHtmlComments(body).trim();
  return { id, title: title ?? id, source, body: text };
}

function authoredSections(): Section[] {
  return [
    requiredPage(
      path.join(AUTHORED, 'capabilities.md'),
      'authored/capabilities',
      'flui-authored',
      'the capabilities page is part of the knowledge base.',
    ),
    requiredPage(
      path.join(GEN, 'dashboard-map.generated.md'),
      'authored/dashboard-map',
      'flui-dashboard-map',
      'run `pnpm kb:dashboard-map` (needs a flui-dashboard checkout).',
    ),
  ];
}

function dashboardMapProvenance(): unknown {
  const map = yaml.load(
    fs.readFileSync(path.join(AUTHORED, 'dashboard-map.yaml'), 'utf8'),
    { schema: yaml.JSON_SCHEMA },
  ) as { generatedFrom?: unknown };
  return map?.generatedFrom ?? null;
}

/**
 * Both manifest contracts, or none at all.
 *
 * A skipped schema used to be a `continue`, which compiled a knowledge base that
 * looked complete and answered `kind: Application` questions with the catalog
 * contract. An assistant handed the wrong schema does not fall silent — it
 * writes something plausible and wrong, which is the failure this whole corpus
 * exists to prevent. So a missing file stops the build.
 */
function schemaSection(): Section[] {
  const schemas: Array<{ file: string; id: string; title: string }> = [
    {
      file: 'flui-manifest.schema.json',
      id: 'flui-manifest/schema',
      title: 'flui.yaml manifest — kind: CatalogApp JSON Schema',
    },
    {
      file: 'flui-application.schema.json',
      id: 'flui-application/schema',
      title: 'flui.yaml manifest — kind: Application JSON Schema',
    },
  ];
  return schemas.map(({ file, id, title }) => {
    const full = path.join(SRC, file);
    if (!fs.existsSync(full)) {
      throw new Error(
        `kb-build: ${file} is missing — run \`pnpm kb:sync\` first. ` +
          'The knowledge base is not built without both manifest contracts.',
      );
    }
    return {
      id,
      title,
      source: 'flui-spec' as const,
      body: ['```json', fs.readFileSync(full, 'utf8').trim(), '```'].join('\n'),
    };
  });
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
    spec: {
      application: { schemaId: string; apiVersion: string };
      catalogApp: { schemaId: string; apiVersion: string };
    };
  };

  const sourcesLock = fs.existsSync(path.join(SRC, 'SOURCES.lock.json'))
    ? JSON.parse(fs.readFileSync(path.join(SRC, 'SOURCES.lock.json'), 'utf8'))
    : null;

  const guardrails = fs
    .readFileSync(path.join(SRC, 'guardrails.md'), 'utf8')
    .trim();

  const sections: Section[] = [
    ...loadDir(path.join(SRC, 'concepts'), 'flui-docs', 'concepts'),
    ...loadDir(path.join(SRC, 'tasks'), 'flui-docs', 'tasks'),
    ...authoredSections(),
    ...cliReferenceSection(),
    ...loadDir(path.join(SRC, 'cli-prose'), 'flui-docs', 'cli'),
    ...schemaSection(),
  ];

  if (markupProblems.length) {
    throw new Error(
      `kb-build: MDX markup left after cleaning (teach scripts/kb-mdx.ts the component):\n  ${markupProblems.join('\n  ')}`,
    );
  }

  const kb: CompiledKb = {
    kbVersion: version.kbVersion,
    compatibility: {
      cli: version.cli,
      platform: version.platform,
      spec: version.spec,
      sources: sourcesLock
        ? {
            ...sourcesLock.syncedFrom,
            dashboardMap: dashboardMapProvenance(),
            counts: sourcesLock.counts,
            skippedDrafts,
          }
        : null,
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
    `> Compiled artifact. CLI \`${kb.compatibility.cli}\` · platform \`${kb.compatibility.platform.version}\` · spec \`${kb.compatibility.spec.application.apiVersion}\` + \`${kb.compatibility.spec.catalogApp.apiVersion}\`. Regenerate with \`pnpm kb:build\`.`,
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
    `kb-build: v${kb.kbVersion} · ${sections.length} sections (${skippedDrafts.length} drafts skipped) · platform ${kb.compatibility.platform.version} · spec ${kb.compatibility.spec.application.apiVersion} + ${kb.compatibility.spec.catalogApp.apiVersion}`,
  );
}

main();
