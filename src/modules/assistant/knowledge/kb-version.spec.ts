import * as fs from 'node:fs';
import * as path from 'node:path';
import { KNOWLEDGE_SOURCES, RELEASE } from '../../../config/release.config';
import {
  leftoverComponents,
  stripHtmlComments,
} from '../../../../scripts/kb-mdx';
import { CompiledKb } from './kb.types';

/**
 * The guard that keeps the committed knowledge base the one this release ships.
 *
 * The assistant tells people which Flui it describes from `kb.json`, and the
 * corpus is compiled from docs fetched at a pinned ref. Failing here means
 * running `FLUI_KB_SOURCE=remote pnpm kb`, not editing JSON.
 */
interface Sources {
  docs: { repo: string; ref: string; origin: string; dirty?: boolean };
  counts: { concepts: number; tasks: number; cliProse: number };
  skippedDrafts: string[];
}

const KB = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'dist/kb.json'), 'utf8'),
) as CompiledKb;
const SOURCES = KB.compatibility.sources as Sources;
const CLI_VERSION = (
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '../../../../cli/package.json'),
      'utf8',
    ),
  ) as { version: string }
).version;

/**
 * 0.14.0-rc.1 was built from the local docs checkout because the pinned
 * docsRef lacks the task guides; this exemption names that build and expires
 * with the release. To close it: push flui-docs, set KNOWLEDGE_SOURCES.docsRef,
 * run `FLUI_KB_SOURCE=remote pnpm kb`, delete this exemption.
 */
const PENDING_DOCS_REF: { release: string; builtFromDocs: string } | null = {
  release: '0.14.0-rc.1',
  builtFromDocs: '2910f64eac2d27b2e0fdafa740c21deeac4d14d0',
};

const ids = KB.sections.map((s) => s.id);
const docsSections = KB.sections.filter((s) => s.source === 'flui-docs');
const prefixed = (prefix: string): number =>
  ids.filter((id) => id.startsWith(`${prefix}/`)).length;
const draftsUnder = (prefix: string): number =>
  SOURCES.skippedDrafts.filter((id) => id.startsWith(`${prefix}/`)).length;

describe('the compiled assistant knowledge base', () => {
  describe('version binding', () => {
    it('is the version of the CLI that ships it and of this release', () => {
      expect(KB.kbVersion).toBe(CLI_VERSION);
      expect(KB.compatibility.cli).toBe(CLI_VERSION);
      expect(KB.kbVersion).toBe(RELEASE.version);
    });

    it('describes the platform release RELEASE pins', () => {
      expect(KB.compatibility.platform.version).toBe(RELEASE.version);
      expect(KB.compatibility.platform.bootstrapRef).toBe(RELEASE.bootstrapRef);
      expect(KB.compatibility.platform.images).toEqual({ ...RELEASE.images });
    });
  });

  describe('docs provenance', () => {
    const exempt =
      PENDING_DOCS_REF !== null && RELEASE.version === PENDING_DOCS_REF.release;

    (exempt ? it.skip : it)(
      'was built from the pinned docsRef, not a local checkout',
      () => {
        expect(SOURCES.docs.ref).toBe(KNOWLEDGE_SOURCES.docsRef);
        expect(SOURCES.docs.dirty ?? false).toBe(false);
      },
    );

    it('carries a D-K5 exemption only for the release and build it names', () => {
      if (PENDING_DOCS_REF === null) return;
      expect(RELEASE.version).toBe(PENDING_DOCS_REF.release);
      expect(SOURCES.docs.ref).toBe(PENDING_DOCS_REF.builtFromDocs);
    });
  });

  describe('contents', () => {
    it('has every synced docs page except the unpublished drafts', () => {
      expect(prefixed('concepts')).toBe(
        SOURCES.counts.concepts - draftsUnder('concepts'),
      );
      expect(prefixed('tasks')).toBe(
        SOURCES.counts.tasks - draftsUnder('tasks'),
      );
      expect(docsSections.filter((s) => s.id.startsWith('cli/'))).toHaveLength(
        SOURCES.counts.cliProse - draftsUnder('cli'),
      );
    });

    it('includes the task guides', () => {
      expect(SOURCES.counts.tasks).toBeGreaterThan(0);
      expect(prefixed('tasks')).toBeGreaterThan(0);
    });

    it('keeps the router fallback, the authored pages, the CLI reference and both schemas', () => {
      for (const id of [
        'concepts/00-what-is-flui',
        'authored/capabilities',
        'authored/dashboard-map',
        'cli/reference',
        'flui-manifest/schema',
        'flui-application/schema',
      ]) {
        expect(ids).toContain(id);
      }
    });

    it('names every section once, each with a real title', () => {
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of KB.sections) {
        expect(s.title.trim()).not.toBe('');
        expect(s.title).not.toBe(s.id);
        expect(s.body.trim()).not.toBe('');
      }
    });
  });

  describe('cleaning', () => {
    it('leaves no MDX component markup in the docs', () => {
      const leftovers = docsSections.flatMap((s) =>
        leftoverComponents(s.body).map((tag) => `${s.id}: ${tag}`),
      );
      expect(leftovers).toEqual([]);
    });

    it('leaves no import lines and no HTML comments outside code', () => {
      for (const s of KB.sections.filter((x) => !x.id.endsWith('/schema'))) {
        expect(stripHtmlComments(s.body)).toBe(s.body);
        if (s.source === 'flui-docs') {
          expect(s.body).not.toMatch(/^import\s.+from\s+['"]/m);
        }
      }
    });
  });
});
