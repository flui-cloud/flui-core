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
