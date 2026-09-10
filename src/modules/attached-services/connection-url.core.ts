import { DbEngine } from '../database-console/interfaces/db-connection';
import { ENGINE_PROFILES } from '../database-console/engine/engine-profile';

/**
 * Key under which a building block's own K8s Secret carries its connection URL.
 *
 * It lives in the block's Secret and nowhere else: a URL carries the password,
 * so the only way to hand it to a consumer without copying a credential into
 * another row of our database is a `secretKeyRef` at the block's Secret. That
 * is what `fromService: url` resolves to.
 */
export const CONNECTION_URL_KEY = 'FLUI_CONNECTION_URL';

export interface ConnectionUrlFacts {
  /** `flui.cloud/db-engine` of the block; absent on a block that is not a datastore. */
  engine?: string | null;
  /** In-cluster service host of the block. */
  host: string;
  /** First declared port of the block. */
  port?: number | null;
  /** The block's env, in PLAINTEXT (decrypted), by name. */
  env: Record<string, string>;
}

function isKnownEngine(engine: string): engine is DbEngine {
  return Object.prototype.hasOwnProperty.call(ENGINE_PROFILES, engine);
}

/** First key of `candidates` that `env` holds with a non-empty value. */
function firstPresent(
  env: Record<string, string>,
  candidates: string[],
): string | null {
  for (const key of candidates) {
    const value = env[key];
    if (value !== undefined && value !== '') return value;
  }
  return null;
}

/**
 * Compose a block's connection URL from what the engine profile says it is.
 *
 * Returns `null` — never a half-formed string — when the block declares no
 * engine or an engine we have no profile for. A caller that gets `null` must
 * refuse `fromService: url` by name rather than hand a container an empty
 * variable it will happily start with.
 *
 * The engine profile is the only source of the scheme and of which env keys
 * hold user/password/database, so a block gains a URL form the same day it
 * gains a profile, and never one day earlier.
 */
export function composeConnectionUrl(facts: ConnectionUrlFacts): string | null {
  const engine = facts.engine;
  if (!engine || !isKnownEngine(engine)) return null;

  const profile = ENGINE_PROFILES[engine];
  const port = facts.port ?? profile.defaultPort;
  const user = firstPresent(facts.env, profile.envUserKeys);
  const password = firstPresent(facts.env, profile.secretPasswordKeys);
  const database = firstPresent(facts.env, profile.envDatabaseKeys);

  // `redis://:pass@host` — key-value engines authenticate with the password
  // alone, and the empty user before the colon is the shape their clients parse.
  // An engine with neither gets no `@` at all rather than a bare separator.
  const credentials = buildCredentials(user, password);

  const path = database ? `/${encodeURIComponent(database)}` : '';

  return `${profile.urlScheme}://${credentials}${facts.host}:${port}${path}`;
}

function buildCredentials(
  user: string | null,
  password: string | null,
): string {
  const left = user ? encodeURIComponent(user) : '';
  const right = password ? `:${encodeURIComponent(password)}` : '';
  if (!left && !right) return '';
  return `${left}${right}@`;
}

/** True when this engine has a URL form at all — what the validator refuses on. */
export function engineHasConnectionUrl(engine?: string | null): boolean {
  return !!engine && isKnownEngine(engine);
}
