import { Injectable } from '@nestjs/common';
import { CompiledKb, KbCompatibility, KbSection } from '../knowledge/kb.types';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import kbData = require('../knowledge/dist/kb.json');

const KB = kbData as unknown as CompiledKb;

// Always present even when routing returns nothing usable, so a vague Flui question
// still gets grounded context instead of the whole 76k-token corpus.
const FALLBACK_SECTION_IDS = ['concepts/00-what-is-flui'];

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
  private readonly reminder = [
    '# Reminder',
    'You are the Flui Assistant. Use only the Flui knowledge above.',
    'If a request is not about Flui, refuse briefly and redirect — do not answer it.',
    "If the answer isn't in the knowledge above, say you don't have it and point to `flui <command> --help` or the docs. Never invent commands, flags, fields, or version numbers.",
  ].join('\n');

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
