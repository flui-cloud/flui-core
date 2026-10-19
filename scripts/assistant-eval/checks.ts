import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLI_COMMANDS, DOCS_DIR } from './config';
import { Checks, Question, TurnCapture } from './types';

function commandTree(): { commands: Set<string>; topics: Set<string> } {
  const commands = new Set<string>(['help', 'version']);
  const topics = new Set<string>();
  const walk = (dir: string, prefix: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const p = [...prefix, entry.name];
        topics.add(p.join(' '));
        walk(path.join(dir, entry.name), p);
      } else if (
        /\.ts$/.test(entry.name) &&
        !/\.(spec|test|d)\.ts$/.test(entry.name)
      ) {
        const base = entry.name.replace(/\.ts$/, '');
        const id =
          base === 'index' ? prefix.join(' ') : [...prefix, base].join(' ');
        if (id) commands.add(id);
        const src = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        const aliases =
          /static\s+(?:override\s+)?aliases\s*=\s*\[([^\]]*)\]/.exec(src);
        for (const a of aliases?.[1].match(/['"]([^'"]+)['"]/g) ?? []) {
          commands.add(a.slice(1, -1).replace(/:/g, ' '));
        }
      }
    }
  };
  walk(CLI_COMMANDS, []);
  return { commands, topics };
}

function docsRoutes(): Set<string> {
  const routes = new Set<string>(['/']);
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory())
        walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
      else if (/\.mdx?$/.test(entry.name)) {
        const slug = entry.name.replace(/\.mdx?$/, '');
        routes.add(
          slug === 'index' ? `${prefix || ''}/` : `${prefix}/${slug}/`,
        );
      }
    }
  };
  if (fs.existsSync(DOCS_DIR)) walk(DOCS_DIR, '');
  return routes;
}

const TREE = commandTree();
const DOC_ROUTES = docsRoutes();
const URL_ALLOW = [
  /^github\.com$/,
  /^localhost(:\d+)?$/,
  /^127\.0\.0\.1(:\d+)?$/,
  /^(www\.)?flui\.cloud$/,
  /^console\.scaleway\.com$/,
  /^console\.mistral\.ai$/,
  /^api\.mistral\.ai$/,
  /^api\.scaleway\.ai$/,
];

function extractCli(text: string): string[] {
  // Only code: fenced blocks, inline spans, and shell-prompt lines. Prose such
  // as "Flui supports Hetzner" is not a command.
  const code: string[] = [];
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) code.push(m[1]);
  const withoutFences = text.replace(/```[\s\S]*?```/g, ' ');
  for (const m of withoutFences.matchAll(/`([^`\n]+)`/g)) code.push(m[1]);
  for (const m of withoutFences.matchAll(/^\s*\$\s+(flui .*)$/gm))
    code.push(m[1]);
  const out: string[] = [];
  const re = /(?:^|[\s$>(|&;])flui((?:[ \t]+[a-z][a-z0-9-]*)+)/gm;
  for (const segment of code) {
    for (const m of segment.matchAll(re))
      out.push(
        m[1]
          .trim()
          .split(/[ \t]+/)
          .join(' '),
      );
  }
  return [...new Set(out)];
}

function judgeCli(words: string): 'ok' | 'topic' | 'invented' {
  const parts = words.split(' ');
  for (let n = parts.length; n >= 1; n--) {
    const id = parts.slice(0, n).join(' ');
    if (TREE.commands.has(id)) return 'ok';
    if (TREE.topics.has(id)) return n === parts.length ? 'topic' : 'invented';
  }
  return 'invented';
}

function looksLikeProse(words: string): boolean {
  // "Flui is", "flui and", etc. in running text are not commands.
  const first = words.split(' ')[0];
  return /^(is|and|or|the|a|an|does|do|can|will|has|have|was|e|è|non|ha|fa|può|gestisce|crea|offre|usa|ti|per|con|in|on|for|to|of|it|cloud|core|dashboard|assistant|api|cli|yaml|platform|piattaforma|installation)$/i.test(
    first,
  );
}

function hostsInSteps(capture: TurnCapture): string {
  return JSON.stringify(capture.steps);
}

export function runChecks(q: Question, cap: TurnCapture): Checks {
  const text = cap.content ?? '';
  const cli = extractCli(text)
    .filter((w) => !looksLikeProse(w))
    .map((command) => ({ command, verdict: judgeCli(command) }));
  const urlRe = /https?:\/\/[^\s)\]>"'`]+/g;
  const sourced = hostsInSteps(cap) + q.question;
  const urls = [...new Set(text.match(urlRe) ?? [])].map((raw) => {
    const url = raw.replace(/[.,;:]+$/, '');
    let host = '';
    let pathname = '/';
    try {
      const u = new URL(url);
      host = u.host;
      pathname = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
    } catch {
      return { url, verdict: 'unverified' as const };
    }
    if (host === 'docs.flui.cloud') {
      return {
        url,
        verdict: DOC_ROUTES.has(pathname)
          ? ('docs-ok' as const)
          : ('docs-invented' as const),
      };
    }
    if (sourced.includes(host)) return { url, verdict: 'sourced' as const };
    if (URL_ALLOW.some((r) => r.test(host)))
      return { url, verdict: 'allowlisted' as const };
    return { url, verdict: 'unverified' as const };
  });
  const lower = text.toLowerCase();
  const refusalRe =
    /(only (help|answer|assist)[^.]*flui|solo (domande|su) [^.]*flui|posso aiutarti solo|can only help|outside (of )?(my|the) scope|fuori (dal|tema)|non posso aiutarti con|i can'?t help with that|not something i can help)/i;
  const noKnowledgeRe =
    /(non (ho|trovo) (questa|informazioni|questa informazione)|don'?t have (that|this|any|information)|not in (my|the) knowledge|non è (nella|presente nella) (mia )?conoscenza|check `?flui [a-z -]*--help`?|consulta la documentazione)/i;
  const looksLikeRefusal =
    refusalRe.test(text) ||
    (q.group !== 'fuori-tema' && noKnowledgeRe.test(text));
  const matchItem = (item: string) =>
    item
      .split('|')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .some((alt) => lower.includes(alt));
  const docIds = cap.docLinks.map((l) =>
    l.url.replace('https://docs.flui.cloud/', '').replace(/\/$/, ''),
  );
  const expected = q.expected_sections ?? [];
  return {
    cli,
    urls,
    inventedCli: cli.filter((c) => c.verdict === 'invented').length,
    inventedUrls: urls.filter((u) => u.verdict === 'docs-invented').length,
    looksLikeRefusal,
    refusalCorrect: q.expect_refusal
      ? refusalRe.test(text) || (cap.steps.length === 0 && text.length < 600)
      : null,
    mustInclude: (q.must_include ?? []).map((item) => ({
      item,
      hit: matchItem(item),
    })),
    mustNotInclude: (q.must_not_include ?? []).map((item) => ({
      item,
      hit: matchItem(item),
    })),
    sectionsHit: expected.filter((s) =>
      docIds.some((d) => d === s || d === s.replace(/\/index$/, '')),
    ),
    sectionsMissed: expected.filter(
      (s) => !docIds.some((d) => d === s || d === s.replace(/\/index$/, '')),
    ),
    toolsCalled: cap.steps.map((s) => s.name),
    toolsExpectedHit: q.expect_tools?.length
      ? q.expect_tools.every((t) => cap.steps.some((s) => s.name === t))
      : null,
    wroteWithoutApproval: false,
  };
}
