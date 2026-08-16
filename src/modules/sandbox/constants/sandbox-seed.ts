/**
 * Marks an application the platform put there rather than the guest.
 *
 * This label is a security signal, not a courtesy: content a visitor did not
 * create, sitting unlabelled inside "your" namespace, reads as the leftovers of
 * the previous guest — which is indistinguishable, from the outside, from a
 * failure of the isolation the whole demo is claiming.
 */
export const SEEDED_METADATA = {
  'flui.cloud/seeded': 'true',
  'flui.cloud/seeded-note': 'Seeded by Flui, so you do not start from nothing.',
};

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
