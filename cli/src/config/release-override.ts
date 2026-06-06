/**
 * Per-install override of the pinned release manifest.
 *
 * Default install pins every component to the built-in RELEASE (see
 * src/config/release.config.ts). A local `flui.release.json` in the cwd (or the
 * path in FLUI_RELEASE_FILE) overrides any subset of it — used to install a
 * dev/staging build from a branch, tag or commit. Omitted fields stay pinned.
 *
 * Each value is `branch:<x>` / `tag:<x>` / `commit:<x>` (or a bare literal).
 * Scripts and images resolve a ref differently: scripts take any git ref
 * verbatim (raw.githubusercontent serves branch/tag/sha), while an image tag
 * must match what CI publishes — a branch name sanitized to a tag, or a
 * short commit sha.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  RELEASE,
  resolveBootstrapRef,
  resolveImageTags,
  type ComponentImageTags,
} from 'src/config/release.config';

const OVERRIDE_FILE = 'flui.release.json';
const IMAGE_KEYS = ['fluiApi', 'fluiWeb', 'fluiAuthz'] as const;
type ImageKey = (typeof IMAGE_KEYS)[number];

const COMPONENT_LABELS: Record<ImageKey, string> = {
  fluiApi: 'flui-api (core)',
  fluiWeb: 'flui-web (dashboard)',
  fluiAuthz: 'flui-authz',
};

type RefKind = 'branch' | 'tag' | 'commit' | 'literal';

export interface ReleaseOverrideFile {
  version?: string;
  bootstrapRef?: string;
  images?: Partial<Record<ImageKey, string>>;
}

export interface OverrideEntry {
  label: string;
  spec: string;
  resolved: string;
}

export interface EffectiveRelease {
  version: string | null;
  bootstrapRef: string;
  images: ComponentImageTags;
  source: 'pinned' | 'latest' | 'override';
  overrides: OverrideEntry[];
  filePath: string | null;
}

function parseRef(raw: string): { kind: RefKind; value: string } {
  const idx = raw.indexOf(':');
  if (idx === -1) return { kind: 'literal', value: raw };
  const prefix = raw.slice(0, idx);
  const value = raw.slice(idx + 1);
  switch (prefix) {
    case 'branch':
      return { kind: 'branch', value };
    case 'tag':
      return { kind: 'tag', value };
    case 'commit':
    case 'sha':
      return { kind: 'commit', value };
    default:
      throw new Error(
        `Invalid ref "${raw}" in ${OVERRIDE_FILE}: unknown prefix "${prefix}:" — use branch:/tag:/commit:, or a bare tag.`,
      );
  }
}

/** Mirror docker/metadata-action `type=ref,event=branch`: invalid tag chars → "-". */
function branchToImageTag(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function resolveScriptsRef(spec: string): string {
  return parseRef(spec).value;
}

function resolveImageTag(spec: string): string {
  const ref = parseRef(spec);
  switch (ref.kind) {
    case 'branch':
      return branchToImageTag(ref.value);
    case 'commit':
      return ref.value.slice(0, 7); // CI publishes type=sha,format=short
    default:
      return ref.value;
  }
}

function loadOverrideFile(): {
  data: ReleaseOverrideFile;
  filePath: string;
} | null {
  const explicit = process.env.FLUI_RELEASE_FILE;
  const filePath = explicit
    ? path.resolve(explicit)
    : path.join(process.cwd(), OVERRIDE_FILE);
  if (!fs.existsSync(filePath)) return null;

  let data: ReleaseOverrideFile;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return { data, filePath };
}

let cache: EffectiveRelease | undefined;
let cacheKey: string | undefined;

interface ResolvedRelease {
  version: string | null;
  bootstrapRef: string;
  images: ComponentImageTags;
  overrides: OverrideEntry[];
}

function applyOverride(
  base: ResolvedRelease,
  data: ReleaseOverrideFile,
): ResolvedRelease {
  const images = { ...base.images };
  const overrides: OverrideEntry[] = [];
  let bootstrapRef = base.bootstrapRef;

  if (data.bootstrapRef !== undefined) {
    bootstrapRef = resolveScriptsRef(data.bootstrapRef);
    overrides.push({
      label: 'bootstrap scripts',
      spec: data.bootstrapRef,
      resolved: bootstrapRef,
    });
  }
  for (const k of IMAGE_KEYS) {
    const spec = data.images?.[k];
    if (spec === undefined) continue;
    const resolved = resolveImageTag(spec);
    images[k] = resolved;
    overrides.push({ label: COMPONENT_LABELS[k], spec, resolved });
  }
  return {
    version: data.version ?? base.version,
    bootstrapRef,
    images,
    overrides,
  };
}

export function getEffectiveRelease(useLatest: boolean): EffectiveRelease {
  const key = `${useLatest}|${process.env.FLUI_RELEASE_FILE ?? ''}|${process.cwd()}`;
  if (cache && cacheKey === key) return cache;

  const base: ResolvedRelease = {
    version: useLatest ? null : RELEASE.version,
    bootstrapRef: resolveBootstrapRef(useLatest),
    images: { ...resolveImageTags(useLatest) },
    overrides: [],
  };

  const loaded = loadOverrideFile();
  const resolved = loaded ? applyOverride(base, loaded.data) : base;
  const isOverride = resolved.overrides.length > 0;
  const pinnedSource = useLatest ? 'latest' : 'pinned';

  const eff: EffectiveRelease = {
    version: resolved.version,
    bootstrapRef: resolved.bootstrapRef,
    images: resolved.images,
    source: isOverride ? 'override' : pinnedSource,
    overrides: resolved.overrides,
    filePath: isOverride && loaded ? loaded.filePath : null,
  };
  cache = eff;
  cacheKey = key;
  return eff;
}

export function resolveEffectiveBootstrapRef(useLatest: boolean): string {
  return getEffectiveRelease(useLatest).bootstrapRef;
}

export function resolveEffectiveImageTags(
  useLatest: boolean,
): ComponentImageTags {
  return getEffectiveRelease(useLatest).images;
}

/** Display path: relative when inside cwd, absolute when it would escape it. */
export function displayReleaseFilePath(filePath: string): string {
  const rel = path.relative(process.cwd(), filePath);
  return !rel || rel.startsWith('..') ? filePath : rel;
}

/** Loud banner so a stale override is never installed unnoticed. */
export function formatReleaseOverrideBanner(
  eff: EffectiveRelease,
): string | null {
  if (eff.source !== 'override' || !eff.filePath) return null;
  const rel = displayReleaseFilePath(eff.filePath);
  const lines = eff.overrides.map((o) => {
    const spec = chalk.dim(`(${o.spec})`);
    return `   • ${o.label}: ${chalk.cyan(o.resolved)} ${spec}`;
  });
  return (
    chalk.yellow.bold('\n⚠ Release override active') +
    chalk.dim(` — ${rel}\n`) +
    chalk.dim('  Installing non-default component versions:\n') +
    `${lines.join('\n')}\n`
  );
}
