/**
 * The image a redeploy should ask for, from what the application runs now and
 * what the person typed.
 *
 * A tag on its own says nothing about where the image lives; the repository has
 * to come from the reference already in place. Composing it here rather than in
 * the command keeps the one case that bites — a digest, which joins with `@`
 * and not `:` — in something a test can reach.
 */
export function composeImageRef(
  current: string | undefined,
  target: string,
): string {
  const wanted = target.trim();
  if (!wanted) throw new Error('No image tag or digest given.');

  // Already a full reference: the caller knows better than we do.
  if (wanted.includes('/')) return wanted;

  const repo = repositoryOf(current);
  if (!repo) {
    throw new Error(
      `Cannot tell which image repository "${wanted}" belongs to: this application declares no image yet. Give the full reference instead.`,
    );
  }

  return /^sha256:[0-9a-f]{64}$/.test(wanted)
    ? `${repo}@${wanted}`
    : `${repo}:${wanted}`;
}

/** The repository part of a reference, without its tag or digest. */
export function repositoryOf(ref: string | undefined): string | null {
  if (!ref) return null;
  const atDigest = ref.indexOf('@');
  const base = atDigest === -1 ? ref : ref.slice(0, atDigest);
  const lastColon = base.lastIndexOf(':');
  const lastSlash = base.lastIndexOf('/');
  // A colon before the last slash is a registry port, not a tag.
  const repo = lastColon > lastSlash ? base.slice(0, lastColon) : base;
  return repo || null;
}
