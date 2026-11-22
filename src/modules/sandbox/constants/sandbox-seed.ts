/**
 * The catalog entries offered inside the sandbox. Chosen for one property the
 * demo lives or dies by: a small image that reaches Running in well under a
 * minute. Nothing the trial excludes belongs here (`sandbox-catalog.ts`).
 */
export const SANDBOX_FAST_CATALOG: string[] = [
  'code-server',
  'umami',
  'uptime-kuma',
];

export function isFastCatalogApp(slug: string): boolean {
  return SANDBOX_FAST_CATALOG.includes(slug);
}
