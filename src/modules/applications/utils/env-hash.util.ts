import { createHash } from 'node:crypto';
import { ApplicationEnvVar } from '../interfaces/source-config.interface';
import {
  CONNECTION_URL_KEY,
  DIRECT_URL_KEY,
} from '../../attached-services/connection-url.core';
import { DB_ENGINE_LABEL } from '../../database-console/engine/engine-profile';

export const ENV_HASH_ANNOTATION = 'flui.cloud/env-hash';

/**
 * The variables the pods were started with, as one value on the pod template.
 * A restart re-reads them without changing anything else, so it rewrites this
 * alone; a config hash that also covered the image would then claim a deploy
 * had happened when only a restart did.
 */
export function envHashOf(env: ApplicationEnvVar[] | null | undefined): string {
  const payload = (env ?? [])
    .filter((e) => !e.pending)
    .map((e) => ({
      name: e.name,
      value: e.value,
      secret: !!e.secret,
      ext: e.externalSecretRef ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The variables that differ between what the pods run with and what is saved,
 * by name only — a value, secret or not, never leaves here.
 */
export function envChanges(
  running: ApplicationEnvVar[] | null | undefined,
  saved: ApplicationEnvVar[] | null | undefined,
): string[] {
  const before = new Map(
    (running ?? []).filter((e) => !e.pending).map((e) => [e.name, e]),
  );
  const after = new Map(
    (saved ?? []).filter((e) => !e.pending).map((e) => [e.name, e]),
  );
  const out: string[] = [];
  for (const [name, e] of after) {
    const was = before.get(name);
    if (!was) out.push(`${name} added`);
    else if (was.value !== e.value || !!was.secret !== !!e.secret) {
      out.push(`${name} changed`);
    }
  }
  for (const name of before.keys()) {
    if (!after.has(name)) out.push(`${name} removed`);
  }
  return out.sort((a, b) => Number(a > b) - Number(a < b));
}

/**
 * Variables the PostgreSQL image reads only when it first creates its data
 * directory or bootstraps a standby; a restart of a running database ignores them.
 */
const POSTGRES_INIT_ONLY = new Set([
  'POSTGRES_PASSWORD',
  'POSTGRES_USER',
  'POSTGRES_DB',
  'FLUI_PG_STANDBY',
]);

/**
 * The variables a restart of this application would change. A datastore
 * publishes its connection URLs for its consumers and never reads them, and
 * Flui rewrites them after a deploy (the pooler taking the URL), so they do not
 * ask the datastore for a restart; nor do a PostgreSQL's first-start settings,
 * which a migration rewrites on the copy it promotes.
 */
export function restartEnvOf(app: {
  env?: ApplicationEnvVar[] | null;
  labels?: Record<string, string> | null;
}): ApplicationEnvVar[] {
  const env = app.env ?? [];
  const engine = app.labels?.[DB_ENGINE_LABEL];
  if (!engine) return env;
  return env.filter(
    (e) =>
      e.name !== CONNECTION_URL_KEY &&
      e.name !== DIRECT_URL_KEY &&
      !(
        engine === 'postgres' &&
        (POSTGRES_INIT_ONLY.has(e.name) || e.name.startsWith('FLUI_PG_RESTORE'))
      ),
  );
}
