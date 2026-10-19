import { Injectable } from '@nestjs/common';
import { CompiledKb, KbCompatibility, KbSection } from '../knowledge/kb.types';
import { CONTINUATION_REMINDER, SYSTEM_REMINDER } from '../policy';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import kbData = require('../knowledge/dist/kb.json');

const KB = kbData as unknown as CompiledKb;

// Always present even when routing returns nothing usable, so a vague Flui question
// still gets grounded context instead of the whole 76k-token corpus.
const FALLBACK_SECTION_IDS = ['concepts/00-what-is-flui'];

// Plain words, never the raw source id: models turned `flui-docs` into an
// invented host (https://flui-docs/...).
const SOURCE_LABELS: Record<string, string> = {
  'flui-docs': 'Flui documentation',
  'flui-spec': 'flui.yaml specification',
  'oclif-manifest': 'CLI reference',
  'flui-dashboard-map': 'dashboard map',
  'flui-authored': 'Flui capabilities',
};

const MAX_ROUTED_SECTIONS = 4;
const MAX_LEXICAL_SECTIONS = 3;
// The generated CLI reference alone is ~50k tokens: never a fallback pick.
const MAX_LEXICAL_BODY_CHARS = 50_000;
const STOPWORDS = new Set(
  (
    'the and for with how what when where which who why can does do did are is was ' +
    'you your yours this that these those from into onto about have has had not ' +
    'all any some our out use using get set its there their them they then ' +
    'than but one two way flui want need make should would could will'
  ).split(' '),
);

export type SectionPick = 'router' | 'lexical' | 'fallback';

/** `stable` is identical for every turn of every user; `page` is the surface block. */
export interface PromptParts {
  stable?: string;
  page?: string;
}

export interface SectionSelection {
  sectionIds: string[];
  via: SectionPick;
}

function stem(token: string): string {
  if (token.length <= 4) return token;
  return token.replace(/(ings|ing|ies|es|ed|s)$/, '');
}

function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

interface LexicalEntry {
  id: string;
  title: Set<string>;
  path: Set<string>;
  headings: Set<string>;
}

// Published docs site (Astro Starlight). A section id is its content path under
// src/content/docs minus the extension, so the public route is one pure function of
// the id — no per-page mapping to maintain. Only `flui-docs` sections have a page;
// the generated CLI reference (oclif-manifest) and the schema (flui-spec) do not.
const DOCS_BASE = 'https://docs.flui.cloud';
const DOCS_SOURCE = 'flui-docs';
const MAX_DOC_LINKS = 3;

/**
 * Serves the baked knowledge base as the assistant's system context. Guardrails + version
 * binding are always injected; the corpus is injected selectively (routed section ids) to
 * keep the answering prompt small — the full corpus is a 76k-token prefill otherwise.
 */
@Injectable()
export class KnowledgeService {
  private readonly sectionsById = new Map<string, KbSection>(
    KB.sections.map((s) => [s.id, s]),
  );
  private readonly lexicalIndex: LexicalEntry[] = KB.sections
    .filter((s) => s.body.length <= MAX_LEXICAL_BODY_CHARS)
    .map((s) => ({
      id: s.id,
      title: terms(s.title),
      path: terms(
        s.id
          .split('/')
          .map((segment) => segment.replace(/^\d+-/, ''))
          .join(' '),
      ),
      headings: terms(
        s.body
          .split('\n')
          .filter((line) => line.startsWith('## ') || line.startsWith('### '))
          .join(' '),
      ),
    }));
  private readonly binding = this.composeBinding();
  private readonly reminder = SYSTEM_REMINDER;
  private readonly continuationReminder = CONTINUATION_REMINDER;

  /** Compact id — title list the router selects from. */
  getIndexPrompt(): string {
    return KB.sections.map((s) => `${s.id} — ${s.title}`).join('\n');
  }

  /**
   * The sections a turn is grounded in: the router's known ids when it gave any,
   * otherwise a lexical match of the question against section titles, paths and
   * headings, and only then the generic introduction.
   */
  selectSections(routedIds: string[], query: string): SectionSelection {
    const known = [
      ...new Set(routedIds.filter((id) => this.sectionsById.has(id))),
    ].slice(0, MAX_ROUTED_SECTIONS);
    if (known.length) return { sectionIds: known, via: 'router' };
    const lexical = this.lexicalMatch(query);
    if (lexical.length) return { sectionIds: lexical, via: 'lexical' };
    return { sectionIds: [...FALLBACK_SECTION_IDS], via: 'fallback' };
  }

  lexicalMatch(query: string, limit = MAX_LEXICAL_SECTIONS): string[] {
    const wanted = terms(query);
    if (!wanted.size) return [];
    return this.lexicalIndex
      .map((entry, order) => {
        let score = 0;
        for (const t of wanted) {
          if (entry.title.has(t)) score += 3;
          if (entry.path.has(t)) score += 2;
          if (entry.headings.has(t)) score += 1;
        }
        return { id: entry.id, score, order };
      })
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, limit)
      .map((e) => e.id);
  }

  /**
   * Stable first, variable last: providers bill a repeated prompt prefix at the
   * cached rate, so guardrails, binding and the caller's fixed notes lead, and
   * the per-turn knowledge and page follow.
   */
  getSystemContext(sectionIds?: string[], parts: PromptParts = {}): string {
    const sections = this.resolveSections(sectionIds);
    const corpus = sections
      .map(
        (s) =>
          `## ${s.title}\n_(${SOURCE_LABELS[s.source] ?? 'Flui'})_\n\n${s.body}`,
      )
      .join('\n\n');
    return [
      KB.guardrails,
      this.binding,
      parts.stable,
      '# Flui knowledge',
      corpus,
      parts.page,
      this.reminder,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Lean system context for tool-continuation iterations and the final synthesis:
   * guardrails + version binding only, WITHOUT the KB corpus. The corpus grounds the
   * first decision (answer vs. act); re-sending it each loop iteration is pure token
   * burn (and trips per-minute rate limits on small models). Guardrails persist.
   */
  getBaseContext(parts: PromptParts = {}): string {
    return [
      KB.guardrails,
      this.binding,
      parts.stable,
      parts.page,
      this.continuationReminder,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Canonical documentation links for the sections the router grounded this turn in,
   * resolved deterministically (id → docs route) so the model never composes a doc URL.
   * Capped and deduped; sections without a published page (generated reference, schema)
   * are skipped.
   */
  docLinksFor(sectionIds?: string[]): { title: string; url: string }[] {
    if (!sectionIds?.length) return [];
    const seen = new Set<string>();
    const links: { title: string; url: string }[] = [];
    for (const id of sectionIds) {
      const section = this.sectionsById.get(id);
      if (!section) continue;
      if (section.source !== DOCS_SOURCE || seen.has(section.id)) continue;
      seen.add(section.id);
      const path = section.id.replace(/\/index$/, '');
      links.push({ title: section.title, url: `${DOCS_BASE}/${path}/` });
      if (links.length >= MAX_DOC_LINKS) break;
    }
    return links;
  }

  getInfo(): {
    name: string;
    kbVersion: string;
    compatibility: KbCompatibility;
  } {
    return {
      name: 'Flui Assistant',
      kbVersion: KB.kbVersion,
      compatibility: KB.compatibility,
    };
  }

  private resolveSections(sectionIds?: string[]): KbSection[] {
    if (!sectionIds) return KB.sections;
    const picked = sectionIds
      .map((id) => this.sectionsById.get(id))
      .filter((s): s is KbSection => !!s);
    if (picked.length) return picked;
    return FALLBACK_SECTION_IDS.map((id) => this.sectionsById.get(id)).filter(
      (s): s is KbSection => !!s,
    );
  }

  private composeBinding(): string {
    const c = KB.compatibility;
    return [
      '# Environment you are assisting',
      `- Flui CLI: ${c.cli}`,
      `- Platform release: ${c.platform.version} (api ${c.platform.images.fluiApi}, web ${c.platform.images.fluiWeb}, authz ${c.platform.images.fluiAuthz}; bootstrap ${c.platform.bootstrapRef})`,
      `- flui.yaml schemas: ${c.spec.application.apiVersion} (source deploys) · ${c.spec.catalogApp.apiVersion} (catalog entries)`,
      `- Knowledge base version: ${KB.kbVersion}`,
    ].join('\n');
  }
}
