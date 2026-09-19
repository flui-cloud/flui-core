/**
 * The catalog entries offered inside the sandbox. Chosen for one property the
 * demo lives or dies by: a small image that reaches Running in well under a
 * minute. Immich and Nextcloud are deliberately absent — multi-gigabyte pulls
 * and slow first boots would break the promise the landing page makes, so they
 * appear in the showcase already running instead.
 */
export const SANDBOX_FAST_CATALOG: string[] = [
  'gitea',
  'code-server',
  'umami',
  'uptime-kuma',
  'vaultwarden',
  'memos',
];

export function isFastCatalogApp(slug: string): boolean {
  return SANDBOX_FAST_CATALOG.includes(slug);
}
