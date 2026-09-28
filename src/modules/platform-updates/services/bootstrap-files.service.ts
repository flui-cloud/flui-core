import { Injectable } from '@nestjs/common';
import { parseSecretsIndex } from '../utils/install-values.util';
import { SAFE_NAME } from '../utils/manifest-render.util';

const RAW_BASE =
  'https://raw.githubusercontent.com/flui-cloud/bootstrap-scripts';
const CACHE_MS = 5 * 60_000;

export type ManifestSet = 'control' | 'workload' | 'common';

/** Which of a release's per-type manifest sets a master carries. */
export type MasterKind = 'control' | 'workload';

export interface ReleaseFile {
  name: string;
  set: ManifestSet;
  template: string;
}

export interface ReleaseFiles {
  ref: string;
  /** Whether the release ships an index for this kind of master; without one nothing is added. */
  indexed: boolean;
  /** Basenames the release's indexes declare, for this kind of master and common. */
  declared: Set<string>;
  /**
   * Basename → the recorded variable that must be `true` for the file to be
   * added, from a `requires=<VARIABLE>` in the index.
   */
  requires: Map<string, string>;
  files: Map<string, ReleaseFile>;
}

interface IndexEntry {
  name: string;
  requires?: string;
}

const indexEntries = (text: string | null): IndexEntry[] =>
  (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [name, ...rest] = l.split(/\s+/);
      const requires = rest
        .map((t) => /^requires=([A-Za-z_]\w*)$/.exec(t)?.[1])
        .find(Boolean);
      return requires ? { name, requires } : { name };
    })
    .filter((e) => SAFE_NAME.test(`${e.name}.yaml`));

/**
 * Reading a bootstrap-scripts release: its indexes, its templates and its
 * list of secret variables. A commit ref never changes, so what was read from
 * one is kept for a few minutes; a branch or tag is read every time, so a plan
 * made against it notices when it moved.
 */
@Injectable()
export class BootstrapFilesService {
  private readonly cache = new Map<
    string,
    { at: number; text: string | null }
  >();

  async text(ref: string, path: string): Promise<string | null> {
    const url = `${RAW_BASE}/${encodeURIComponent(ref)}/${path}`;
    const immutable = /^[0-9a-f]{7,40}$/.test(ref);
    const hit = this.cache.get(url);
    if (immutable && hit && Date.now() - hit.at < CACHE_MS) return hit.text;
    const text = await this.fetchText(url).catch(() => null);
    if (immutable) this.cache.set(url, { at: Date.now(), text });
    return text;
  }

  /** Variable → locations, or null when the release ships no such list. */
  async secrets(ref: string): Promise<Map<string, string[]> | null> {
    const text = await this.text(ref, 'manifests/SECRETS');
    return text === null ? null : parseSecretsIndex(text);
  }

  /**
   * What a release has to say about a master. With indexes, the release speaks
   * for a known set. Without the index for this kind of master — an older
   * release — it can still be asked about the files the master already holds,
   * so replacing keeps working and only adding is withheld.
   */
  async releaseFiles(
    ref: string,
    heldByMaster: string[] = [],
    kind: MasterKind = 'control',
  ): Promise<ReleaseFiles> {
    const own = indexEntries(await this.text(ref, `manifests/${kind}/INDEX`));
    const common = indexEntries(await this.text(ref, 'manifests/common/INDEX'));
    const held = heldByMaster
      .filter((n) => n.endsWith('.yaml'))
      .map((n): IndexEntry => ({ name: n.replace(/\.yaml$/, '') }));

    const wanted = new Map<string, ManifestSet>();
    const requires = new Map<string, string>();
    for (const e of own.length > 0 ? own : held) {
      wanted.set(e.name, kind);
      if (e.requires) requires.set(`${e.name}.yaml`, e.requires);
    }
    for (const e of common) wanted.set(e.name, 'common');

    const files = new Map<string, ReleaseFile>();
    await Promise.all(
      [...wanted].map(async ([name, set]) => {
        const template = await this.text(ref, `manifests/${set}/${name}.yaml`);
        if (template !== null) {
          files.set(`${name}.yaml`, { name: `${name}.yaml`, set, template });
        }
      }),
    );
    return {
      ref,
      indexed: own.length > 0,
      declared: new Set([...own, ...common].map((e) => `${e.name}.yaml`)),
      requires,
      files,
    };
  }

  /**
   * The templates a release ships for these basenames, wherever it keeps them.
   * Used to find what rendered a master's files, where no index is trusted.
   */
  async templatesFor(
    ref: string,
    names: string[],
    kind: MasterKind = 'control',
  ): Promise<ReleaseFile[]> {
    const out: ReleaseFile[] = [];
    await Promise.all(
      names.map(async (name) => {
        for (const set of [kind, 'common'] as const) {
          const template = await this.text(ref, `manifests/${set}/${name}`);
          if (template !== null) {
            out.push({ name, set, template });
            return;
          }
        }
      }),
    );
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status}`);
    }
    return response.text();
  }
}
