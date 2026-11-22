import { ForbiddenException } from '@nestjs/common';

/**
 * Catalog entries a trial area may not install: they publish files or images
 * that clients fetch outside a browser, hold other people's passwords, or send
 * requests and mail in bulk, or need a public UDP port a trial never gets.
 * Overridden whole by `SANDBOX_CATALOG_EXCLUDED`, a comma-separated list; an
 * empty value excludes nothing.
 */
export const DEFAULT_TRIAL_EXCLUDED_CATALOG = [
  'harbor',
  'vaultwarden',
  'nextcloud',
  'gitea',
  'activepieces',
  'airflow',
  'jitsi',
];

export const SANDBOX_CATALOG_EXCLUDED_CODE = 'SANDBOX_CATALOG_EXCLUDED';

export function trialExcludedCatalog(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.SANDBOX_CATALOG_EXCLUDED;
  if (raw === undefined) return DEFAULT_TRIAL_EXCLUDED_CATALOG;
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function assertInstallableInTrial(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!trialExcludedCatalog(env).includes(slug.toLowerCase())) return;
  throw new ForbiddenException({
    code: SANDBOX_CATALOG_EXCLUDED_CODE,
    message: `${slug} is not part of the trial. It is available on your own Flui installation or on the managed offer.`,
  });
}
