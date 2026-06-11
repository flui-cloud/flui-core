import { Injectable } from '@nestjs/common';
import { CompiledKb, KbCompatibility, KbSection } from '../knowledge/kb.types';
import { CONTINUATION_REMINDER, SYSTEM_REMINDER } from '../policy';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import kbData = require('../knowledge/dist/kb.json');

const KB = kbData as unknown as CompiledKb;

// Always present even when routing returns nothing usable, so a vague Flui question
// still gets grounded context instead of the whole 76k-token corpus.
const FALLBACK_SECTION_IDS = ['concepts/00-what-is-flui'];

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
  private readonly binding = this.composeBinding();
  private readonly reminder = SYSTEM_REMINDER;
  private readonly continuationReminder = CONTINUATION_REMINDER;

  /** Compact id — title list the router selects from. */
  getIndexPrompt(): string {
    return KB.sections.map((s) => `${s.id} — ${s.title}`).join('\n');
  }

  getSystemContext(sectionIds?: string[]): string {
    const sections = this.resolveSections(sectionIds);
    const corpus = sections
      .map(
        (s) => `## ${s.title}\n_(${s.id} · source: ${s.source})_\n\n${s.body}`,
      )
      .join('\n\n');
    return [
      KB.guardrails,
      this.binding,
      '# Flui knowledge',
      corpus,
      this.reminder,
    ].join('\n\n');
  }

  /**
   * Lean system context for tool-continuation iterations and the final synthesis:
   * guardrails + version binding only, WITHOUT the KB corpus. The corpus grounds the
   * first decision (answer vs. act); re-sending it each loop iteration is pure token
   * burn (and trips per-minute rate limits on small models). Guardrails persist.
   */
  getBaseContext(): string {
    return [KB.guardrails, this.binding, this.continuationReminder].join(
      '\n\n',
    );
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
      `- flui.yaml schema: ${c.spec.apiVersion}`,
      `- Knowledge base version: ${KB.kbVersion}`,
    ].join('\n');
  }
}
