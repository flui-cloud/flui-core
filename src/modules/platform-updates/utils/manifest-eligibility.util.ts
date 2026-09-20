import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';

/**
 * Whether a manifest on a master may be replaced from a release, decided by
 * what the file contains rather than by what it is called.
 *
 * A name list was the obvious design and it is wrong. The rule everyone states
 * is "never touch 00-secrets.yaml", and a live master carries `kind: Secret` in
 * **two** files — that one and `11-zitadel.yaml`. A list that is right today is
 * a list that is wrong at the next release, silently, in the one direction that
 * destroys an installation.
 *
 * Nothing here talks to a cluster or a filesystem. The decisions worth being
 * sure about are the ones made here, so they are made where a test can ask.
 */

const OWNER_LABELS = ['flui.cloud/owner-kind', 'flui.cloud/owner-id'] as const;

/**
 * Deliberately not `localeCompare`: the order feeds a digest, and a digest that
 * depends on the machine's locale is a digest two machines disagree about.
 */
const byBytes = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/**
 * A placeholder is `${NAME}`; a bare `$NAME` is somebody else's.
 *
 * The same rule the installer renders by, and it has to stay the same: this
 * decides whether a file needs values and that decides which names get them.
 * `04c-vmalert.yaml` declares no placeholder yet carries 16 alert annotations
 * reading `{{ $labels.namespace }}` — counting those would make the file with
 * the most to gain permanently ineligible.
 */
export function placeholdersIn(text: string): string[] {
  const found = new Set<string>();
  for (const [, name] of text.matchAll(/\$\{([A-Za-z_]\w*)\}/g)) {
    found.add(name);
  }
  return [...found].sort(byBytes);
}

/** Parses, or throws with the parser's own complaint. */
export function documentsOf(content: string): unknown[] {
  return yaml.loadAll(content).filter((d) => d !== null && d !== undefined);
}

const asRecord = (doc: unknown): Record<string, unknown> =>
  typeof doc === 'object' && doc !== null
    ? (doc as Record<string, unknown>)
    : {};

/** A name off a manifest is whatever was written there; only a string is one. */
const nameOf = (value: unknown): string =>
  typeof value === 'string' ? value : '';

export function carriesSecret(docs: unknown[]): boolean {
  return docs.some((d) => asRecord(d).kind === 'Secret');
}

/**
 * Every resource says who put it there, or the file is not ours to rewrite.
 *
 * `check-manifest-provenance.sh` makes this true of everything in the
 * repository and states the inverse: nothing k3s installs carries these labels.
 * So the label is the line between what a release may speak for and what it
 * may not.
 */
export function declaresProvenance(docs: unknown[]): boolean {
  const resources = docs.filter((d) => 'kind' in asRecord(d));
  if (resources.length === 0) return false;
  return resources.every((doc) => {
    const meta = asRecord(asRecord(doc).metadata);
    const labels = asRecord(meta.labels);
    return OWNER_LABELS.every((key) => Boolean(labels[key]));
  });
}

export interface ImageChange {
  workload: string;
  from: string;
  to: string;
}

/**
 * An image change on a workload that owns data.
 *
 * `02-postgres.yaml` passes every other test — no placeholder, ours, no Secret —
 * and names `postgres:15-alpine` beside a volume claim. Safe to *rewrite* is not
 * safe to *run*, and only the second one loses data.
 */
export function statefulImageChanges(
  current: unknown[],
  next: unknown[],
): ImageChange[] {
  const before = imagesByWorkload(current);
  const changes: ImageChange[] = [];
  for (const [workload, { image, stateful }] of imagesByWorkload(next)) {
    if (!stateful) continue;
    const previous = before.get(workload);
    if (previous && previous.image !== image) {
      changes.push({ workload, from: previous.image, to: image });
    }
  }
  return changes;
}

function imagesByWorkload(
  docs: unknown[],
): Map<string, { image: string; stateful: boolean }> {
  const out = new Map<string, { image: string; stateful: boolean }>();
  for (const doc of docs) {
    const d = asRecord(doc);
    const kind = d.kind;
    if (
      kind !== 'Deployment' &&
      kind !== 'StatefulSet' &&
      kind !== 'DaemonSet'
    ) {
      continue;
    }
    const name = nameOf(asRecord(d.metadata).name);
    const spec = asRecord(d.spec);
    const podSpec = asRecord(asRecord(spec.template).spec);
    const containers = Array.isArray(podSpec.containers)
      ? podSpec.containers
      : [];
    const volumes = Array.isArray(podSpec.volumes) ? podSpec.volumes : [];
    const stateful =
      Array.isArray(spec.volumeClaimTemplates) ||
      volumes.some((v) => 'persistentVolumeClaim' in asRecord(v));
    for (const container of containers) {
      const image = asRecord(container).image;
      if (typeof image !== 'string') continue;
      const containerName = nameOf(asRecord(container).name);
      out.set(`${kind}/${name}/${containerName}`, {
        image,
        stateful,
      });
    }
  }
  return out;
}

export type Action = 'replace' | 'add' | 'unchanged' | 'skip';

export interface Candidate {
  /** Basename as it appears in the manifest directory. */
  name: string;
  /** The file as the release ships it. */
  release: string;
  /** The file as the master holds it, absent when the master has no such file. */
  current?: string;
  /** Whether the master's copy carries a Secret, told by the reader that saw it. */
  currentCarriesSecret?: boolean;
  /** Whether the release declares this file in its index. */
  declaredByRelease: boolean;
}

export interface Judgement {
  name: string;
  action: Action;
  reason?: string;
  placeholders?: string[];
  statefulImageChanges?: ImageChange[];
}

/**
 * One file, one verdict. A refusal never fails the run — it is reported beside
 * the files that will change, because "here is what I will not touch and why"
 * is most of what makes this command safe to run at all.
 */
export function judge(
  candidate: Candidate,
  options: { allowStatefulImageChange?: boolean } = {},
): Judgement {
  const { name, release, current } = candidate;

  let releaseDocs: unknown[];
  try {
    releaseDocs = documentsOf(release);
  } catch (error) {
    return {
      name,
      action: 'skip',
      reason: `the release's copy does not parse as YAML: ${(error as Error).message}`,
    };
  }
  if (
    releaseDocs.length === 0 ||
    !releaseDocs.some((d) => 'kind' in asRecord(d))
  ) {
    return {
      name,
      action: 'skip',
      reason: 'the release ships no resource in this file',
    };
  }

  if (carriesSecret(releaseDocs) || candidate.currentCarriesSecret) {
    return {
      name,
      action: 'skip',
      reason:
        'carries a Secret; its values exist only on this master. No release refreshes this file.',
    };
  }

  if (!declaresProvenance(releaseDocs)) {
    return {
      name,
      action: 'skip',
      reason:
        'not created by Flui (no flui.cloud/owner-kind label); k3s owns it.',
    };
  }

  const placeholders = placeholdersIn(release);
  if (placeholders.length > 0) {
    return {
      name,
      action: 'skip',
      placeholders,
      reason: `needs ${placeholders.join(', ')}; this command supplies no values.`,
    };
  }

  if (current === undefined) {
    if (!candidate.declaredByRelease) {
      return {
        name,
        action: 'skip',
        reason: 'not declared in this release index, so it is not added.',
      };
    }
    return { name, action: 'add' };
  }

  if (current === release) return { name, action: 'unchanged' };

  let currentDocs: unknown[];
  try {
    currentDocs = documentsOf(current);
  } catch {
    // A file on the master that no longer parses is the strongest possible
    // reason to replace it, not a reason to refuse: k3s is failing on it right
    // now. The stateful-image check is skipped because there is nothing to
    // compare, which is stated rather than silently assumed safe.
    return {
      name,
      action: 'replace',
      reason: "the master's copy does not parse",
    };
  }

  if (!declaresProvenance(currentDocs)) {
    return {
      name,
      action: 'skip',
      reason:
        "the master's copy declares no provenance, so this release cannot claim it.",
    };
  }

  const changes = statefulImageChanges(currentDocs, releaseDocs);
  if (changes.length > 0 && !options.allowStatefulImageChange) {
    const [first] = changes;
    return {
      name,
      action: 'skip',
      statefulImageChanges: changes,
      reason: `changes the image of a workload with a volume (${first.from} → ${first.to}). Pass --allow-stateful-image-change after reading the release notes.`,
    };
  }

  return { name, action: 'replace', statefulImageChanges: changes };
}

/**
 * What the person previewed, in one value.
 *
 * Apply recomputes it on the master and refuses when it differs, so a plan can
 * only be applied against the state it was made from. It covers the release
 * commit and both sides' digests per file.
 */
export function planDigest(
  commit: string,
  entries: Array<{
    name: string;
    action: Action;
    currentSha?: string;
    releaseSha?: string;
  }>,
): string {
  const lines = entries
    .map(
      (e) =>
        `${e.action} ${e.name} ${e.currentSha ?? '-'} ${e.releaseSha ?? '-'}`,
    )
    .sort(byBytes);
  return createHash('sha256')
    .update([commit, ...lines].join('\n'))
    .digest('hex')
    .slice(0, 12);
}

export const sha256 = (content: string): string =>
  createHash('sha256').update(content).digest('hex');
