/**
 * The catalog entries offered inside the sandbox. Chosen for one property the
 * demo lives or dies by: a small image that reaches Running in well under a
 * minute. Nextcloud is deliberately absent — a multi-gigabyte pull and a slow
 * first boot would break the promise the landing page makes, so it appears in
 * the showcase already running instead.
 */
export const SANDBOX_FAST_CATALOG: string[] = [
  'gitea',
  'code-server',
  'umami',
  'uptime-kuma',
  'vaultwarden',
];

export function isFastCatalogApp(slug: string): boolean {
  return SANDBOX_FAST_CATALOG.includes(slug);
}
