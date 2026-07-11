/**
 * Single source of truth for composing GHCR image references. Monorepo apps push
 * to `ghcr.io/{owner}/{repo}/{subPath}:{tag}`; single-app repos to
 * `ghcr.io/{owner}/{repo}:{tag}`. Every caller MUST go through here so no path
 * can silently drop the subPath and roll out a nonexistent `{repo}:{tag}`.
 */
export function composeGhcrImageRef(opts: {
  owner: string;
  repoName: string;
  tag: string;
  subPath?: string | null;
}): string {
  const owner = opts.owner.toLowerCase();
  const repo = opts.repoName.toLowerCase();
  const sub = opts.subPath ? `/${opts.subPath.toLowerCase()}` : '';
  return `ghcr.io/${owner}/${repo}${sub}:${opts.tag}`;
}

/**
 * Repair a monorepo ref that dropped its subPath: a bare
 * `ghcr.io/{owner}/{repo}:{tag}` never exists (the package is `{repo}/{subPath}`)
 * and would ImagePullBackOff. No-op when there's no subPath, it's already
 * present, or the ref isn't GHCR.
 */
export function normalizeMonorepoImageRef(
  imageRef: string,
  subPath?: string | null,
): string {
  if (!imageRef || !subPath) return imageRef;
  // Matches only a bare ref (no path segment after `{repo}`); one that already
  // has `/subPath` fails the `[^/@:]+` stop. Group 2 is `:tag` or `@digest`.
  const bare = /^(ghcr\.io\/[^/]+\/[^/@:]+)([:@].+)$/i.exec(imageRef);
  if (!bare) return imageRef;
  return `${bare[1].toLowerCase()}/${subPath.toLowerCase()}${bare[2]}`;
}
