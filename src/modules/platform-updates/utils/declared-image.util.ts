/**
 * Rewriting the image a manifest on the master declares, one line at a time.
 *
 * A line substitution and never a re-render: the master's copy is not the
 * template — `envsubst` filled it, and on a nip.io install a conditional `sed`
 * bound its IngressRoutes to the TLS secret. Rebuilding it from the release
 * would take the TLS away, which is why nothing here parses and dumps.
 */

/** `ghcr.io/flui-cloud/core:1.2.3` → `{ repository, tag }`, or null if untagged. */
export function splitImageRef(
  ref: string,
): { repository: string; tag: string } | null {
  const withoutDigest = ref.split('@')[0];
  const colon = withoutDigest.lastIndexOf(':');
  if (colon <= 0) return null;
  const tag = withoutDigest.slice(colon + 1);
  // A colon inside the registry host's port, not a tag: `host:5000/org/name`.
  if (tag.length === 0 || tag.includes('/')) return null;
  return { repository: withoutDigest.slice(0, colon), tag };
}

/**
 * The repository without its registry host, so a mirrored install matches.
 *
 * The tag on the master's file names whatever registry the cluster pulls from,
 * and the running Deployment may name another. Comparing the full strings makes
 * a pin on a mirror match nothing and report success, which is the same shape of
 * silence as the defect being fixed.
 */
export function bareRepository(repository: string): string {
  const slash = repository.indexOf('/');
  if (slash < 0) return repository;
  const head = repository.slice(0, slash);
  const isHost =
    head.includes('.') || head.includes(':') || head === 'localhost';
  return isHost ? repository.slice(slash + 1) : repository;
}

const IMAGE_LINE = /^(\s*(?:-\s+)?image:\s*)(['"]?)([^'"\s#]+)\2(\s*(?:#.*)?)$/;

export interface PinOutcome {
  content: string;
  /** Files whose line already named this ref count as declared, not as changed. */
  declared: boolean;
  changed: boolean;
  /** Set when the file names this repository but must not be rewritten. */
  refusal?: string;
}

/**
 * Point every line naming this repository at `ref`.
 *
 * A file still carrying `${FLUI_API_IMAGE_TAG}` is refused rather than filled
 * in: substituting a value for the first time is rendering, and rendering a
 * master's copy is exactly what this module exists not to do.
 */
export function pinImageIn(content: string, ref: string): PinOutcome {
  const target = splitImageRef(ref);
  if (!target) {
    return {
      content,
      declared: false,
      changed: false,
      refusal: `"${ref}" carries no tag, so there is nothing to declare`,
    };
  }
  const wanted = bareRepository(target.repository);

  let declared = false;
  let changed = false;
  let refusal: string | undefined;

  const lines = content.split('\n').map((line) => {
    const match = IMAGE_LINE.exec(line);
    if (!match) return line;
    const [, head, quote, value, tail] = match;

    if (value.includes('${') || value.includes('$(')) {
      // Only a line for *our* repository is worth refusing over; anything else
      // unrendered is another file's business and is left exactly as found.
      if (value.includes(wanted)) {
        refusal = 'the file was never rendered on this master';
      }
      return line;
    }

    const found = splitImageRef(value);
    if (!found || bareRepository(found.repository) !== wanted) return line;

    declared = true;
    // Written back with the file's own registry host: a mirror pulls from the
    // mirror, and only the tag was ever out of date.
    const pinned = `${found.repository}:${target.tag}`;
    if (pinned === value) return line;
    changed = true;
    return `${head}${quote}${pinned}${quote}${tail}`;
  });

  if (refusal) return { content, declared: true, changed: false, refusal };
  return { content: lines.join('\n'), declared, changed };
}

/** Just what settledness is read from, so this file needs no Kubernetes client. */
export interface RolloutStatus {
  metadata?: { generation?: number };
  spec?: { replicas?: number };
  status?: {
    observedGeneration?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
  };
}

/**
 * Whether a Deployment has finished arriving at what it was told to run.
 *
 * `spec` is the desired image, not the running one. Declaring it mid-rollout
 * writes a tag that may never come up — and then every restart reasserts it,
 * which is worse than the drift this repairs: today a bad update is undone by
 * the next restart, and a pin done too early would make the restart redo it.
 */
export function hasSettled(deployment: RolloutStatus): boolean {
  const desired = deployment.spec?.replicas ?? 0;
  if (desired === 0) return false;
  const status = deployment.status ?? {};
  return (
    (status.observedGeneration ?? 0) >=
      (deployment.metadata?.generation ?? 0) &&
    status.updatedReplicas === desired &&
    status.readyReplicas === desired &&
    status.availableReplicas === desired
  );
}
