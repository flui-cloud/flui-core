import { createHash } from 'node:crypto';
import {
  InstallTransforms,
  placeholdersIn,
  renderManifestFile,
} from './manifest-render.util';
import {
  ImageChange,
  byBytes,
  carriesSecret,
  declaresProvenance,
  declaresResource,
  documentsOf,
  statefulImageChanges,
  statefulImageChangesAgainst,
} from './manifest-documents.util';

export { placeholdersIn } from './manifest-render.util';

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

export type Action = 'replace' | 'add' | 'unchanged' | 'skip';

export interface JudgeOptions {
  allowStatefulImageChange?: boolean;
  allowOverwriteModified?: boolean;
}

export interface Candidate {
  /** Basename as it appears in the manifest directory. */
  name: string;
  /** The file as the release ships it: the template, before any value. */
  release: string;
  /** The file as the master holds it, absent when the master has no such file. */
  current?: string;
  /** Whether the master's copy carries a Secret, told by the reader that saw it. */
  currentCarriesSecret?: boolean;
  /** Whether the release declares this file in its index. */
  declaredByRelease: boolean;
  /**
   * The index installs this file only where the installer recorded
   * `variable` as `true`; `recorded` says whether this installation's record
   * does. Only adding is gated: a copy the master already holds is kept current.
   */
  requires?: { variable: string; recorded: boolean };
  /**
   * The master's copy exists but only its digest came back, because a template
   * of this file names a secret. Judged on the digest, the live images and the
   * provenance the reader counted.
   */
  currentWithheld?: {
    sha: string;
    declaresProvenance: boolean;
    /** `Kind/name/container` → the image the cluster runs; absent if unread. */
    runningImages?: ReadonlyMap<string, string>;
  };
  /**
   * No template this installation may come from reproduces the master's
   * copy, and no secret explains why: somebody changed it there.
   */
  currentModified?: boolean;
  /** Copied by the installer as downloaded, so never rendered. */
  raw?: boolean;
  /**
   * Values proven for this installation, by variable. Absent means there is
   * no proven record at all, and `valuesUnavailable` says why.
   */
  values?: Readonly<Record<string, string>>;
  valuesUnavailable?: string;
  /** Why a value a file needs is not among the proven ones, by variable. */
  unproven?: Readonly<Record<string, string>>;
  /** Variables listed in `manifests/SECRETS`: never supplied by this command. */
  secretVariables?: ReadonlySet<string>;
  transforms?: InstallTransforms;
  /**
   * Secrets the file's pods need that this installation lacks, and whether the
   * value can be copied from another place the release lists for it.
   */
  missingSecrets?: Array<{
    ref: string;
    derivable: boolean;
    /** The listed source that exists but holds no such key, as `ns/name/key`. */
    missingKey?: string;
  }>;
}

export interface Judgement {
  name: string;
  action: Action;
  reason?: string;
  placeholders?: string[];
  statefulImageChanges?: ImageChange[];
  renderedWith?: string[];
  /** Secrets created from their listed source before the file is written. */
  createsSecrets?: string[];
  /** Keys a Secret would be copied from but its source does not hold. */
  missingSecretKeys?: string[];
}

/** The file as it would be written: the template with the candidate's values. */
export function renderedRelease(candidate: Candidate): string {
  if (candidate.raw) return candidate.release;
  return renderManifestFile(
    candidate.name,
    candidate.release,
    candidate.values ?? {},
    candidate.transforms,
  );
}

/**
 * One file, one verdict. A refusal never fails the run — it is reported beside
 * the files that will change, because "here is what I will not touch and why"
 * is most of what makes this command safe to run at all.
 */
export function judge(
  candidate: Candidate,
  options: JudgeOptions = {},
): Judgement {
  const verdict = judgeContent(candidate, options);
  if (verdict.action !== 'replace' && verdict.action !== 'add') return verdict;
  const missing = candidate.missingSecrets ?? [];
  const underivable = missing.filter((m) => !m.derivable);
  if (underivable.length > 0) {
    const keys = underivable.flatMap((m) =>
      m.missingKey ? [m.missingKey] : [],
    );
    const secrets = underivable.map((m) => m.ref).join(', ');
    const missingKeys = keys.length
      ? ` The key it would copy is missing: ${keys.join(', ')}.`
      : '';
    return {
      name: verdict.name,
      action: 'skip',
      reason: `reads the Secret ${secrets}, which this installation does not have and this command cannot create from a value it already holds.${missingKeys}`,
      ...(keys.length ? { missingSecretKeys: keys } : {}),
    };
  }
  return missing.length > 0
    ? { ...verdict, createsSecrets: missing.map((m) => m.ref) }
    : verdict;
}

function judgeContent(candidate: Candidate, options: JudgeOptions): Judgement {
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
  const refusal = releaseRefusal(candidate, releaseDocs);
  if (refusal) return { name, action: 'skip', reason: refusal };

  const placeholders = candidate.raw ? [] : placeholdersIn(release);
  if (placeholders.length > 0) {
    const refusal = valuesRefusal(candidate, placeholders);
    if (refusal) return { name, action: 'skip', placeholders, reason: refusal };
  }
  const extras: Pick<Judgement, 'renderedWith'> =
    placeholders.length > 0 ? { renderedWith: placeholders } : {};

  const content = renderedRelease(candidate);
  if (content !== release) {
    try {
      releaseDocs = documentsOf(content);
    } catch (error) {
      return {
        name,
        action: 'skip',
        placeholders,
        reason: `does not parse once rendered with this installation's values: ${(error as Error).message}`,
      };
    }
  }

  if (candidate.currentWithheld && current === undefined) {
    return judgeWithheld(
      candidate.currentWithheld,
      name,
      content,
      releaseDocs,
      extras,
      options,
      candidate.currentModified ?? false,
    );
  }

  if (current === undefined) {
    if (!candidate.declaredByRelease) {
      return {
        name,
        action: 'skip',
        reason: 'not declared in this release index, so it is not added.',
      };
    }
    return { name, action: 'add', ...extras };
  }

  return judgeAgainstCurrent(
    name,
    current,
    content,
    releaseDocs,
    extras,
    options,
  );
}

function releaseRefusal(
  candidate: Candidate,
  releaseDocs: unknown[],
): string | undefined {
  if (releaseDocs.length === 0 || !declaresResource(releaseDocs)) {
    return 'the release ships no resource in this file';
  }
  if (carriesSecret(releaseDocs) || candidate.currentCarriesSecret) {
    return 'carries a Secret; its values exist only on this master. No release refreshes this file.';
  }
  if (!declaresProvenance(releaseDocs)) {
    return 'not created by Flui (no flui.cloud/owner-kind label); k3s owns it.';
  }
  if (
    candidate.current === undefined &&
    !candidate.currentWithheld &&
    candidate.requires &&
    !candidate.requires.recorded
  ) {
    return `installed only where ${candidate.requires.variable} was set when the cluster was built, and this installation's record does not say it was; not added.`;
  }
  return undefined;
}

function judgeAgainstCurrent(
  name: string,
  current: string,
  content: string,
  releaseDocs: unknown[],
  extras: Pick<Judgement, 'renderedWith'>,
  options: JudgeOptions,
): Judgement {
  if (current === content) return { name, action: 'unchanged' };

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
      ...extras,
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

  return {
    name,
    action: 'replace',
    statefulImageChanges: changes,
    ...extras,
  };
}

function valuesRefusal(
  candidate: Candidate,
  placeholders: string[],
): string | null {
  const secret = placeholders.filter((p) => candidate.secretVariables?.has(p));
  if (secret.length > 0) {
    return `reads ${secret.join(', ')}, a secret only the installer supplies; this command never renders it.`;
  }
  if (!candidate.values) {
    const why = candidate.valuesUnavailable
      ? ` ${candidate.valuesUnavailable}`
      : '';
    return `needs ${placeholders.join(', ')}; this command supplies no values without a proven record of this installation's.${why}`;
  }
  const missing = placeholders.filter(
    (p) => candidate.values?.[p] === undefined,
  );
  if (missing.length === 0) return null;
  const reasons = missing.map((p) =>
    candidate.unproven?.[p] ? `${p} (${candidate.unproven[p]})` : p,
  );
  return `needs ${reasons.join(', ')}; no proven value is recorded for this installation.`;
}

/**
 * The master's copy never left the master, so all that can be compared is its
 * digest; what it runs is read from the cluster instead of from the file.
 */
function judgeWithheld(
  held: NonNullable<Candidate['currentWithheld']>,
  name: string,
  content: string,
  releaseDocs: unknown[],
  extras: Pick<Judgement, 'renderedWith'>,
  options: JudgeOptions,
  modified: boolean,
): Judgement {
  if (sha256(content) === held.sha) return { name, action: 'unchanged' };
  if (modified && !options.allowOverwriteModified) {
    return {
      name,
      action: 'skip',
      reason:
        'modified on this master: no release this installation may come from reproduces its copy. Pass --overwrite-modified to replace it anyway.',
    };
  }
  if (!held.declaresProvenance) {
    return {
      name,
      action: 'skip',
      reason:
        "the master's copy declares no provenance, so this release cannot claim it.",
    };
  }
  if (!held.runningImages) {
    return {
      name,
      action: 'skip',
      reason:
        "the master's copy is not read back because it may hold a secret, and the images its workloads run could not be read to compare against.",
    };
  }
  const changes = statefulImageChangesAgainst(held.runningImages, releaseDocs);
  if (changes.length > 0 && !options.allowStatefulImageChange) {
    const [first] = changes;
    return {
      name,
      action: 'skip',
      statefulImageChanges: changes,
      reason: `changes the image of a workload with a volume (${first.from} → ${first.to}). Pass --allow-stateful-image-change after reading the release notes.`,
    };
  }
  return {
    name,
    action: 'replace',
    statefulImageChanges: changes,
    ...extras,
  };
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
  valuesDigest = '-',
): string {
  const lines = entries
    .map(
      (e) =>
        `${e.action} ${e.name} ${e.currentSha ?? '-'} ${e.releaseSha ?? '-'}`,
    )
    .sort(byBytes);
  return createHash('sha256')
    .update([commit, valuesDigest, ...lines].join('\n'))
    .digest('hex')
    .slice(0, 12);
}

export const sha256 = (content: string): string =>
  createHash('sha256').update(content).digest('hex');
