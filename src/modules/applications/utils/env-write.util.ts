import { ApplicationEnvVar } from '../interfaces/source-config.interface';

/**
 * Values the UI renders in place of a stored secret. A payload carrying one of
 * these is the editor echoing back a value it never had — writing it would
 * replace the real credential with the mask.
 */
const SECRET_MASKS = new Set(['****', '********']);

/** Why a key is left alone: the catalog wiring owns it, not this editor. */
const LINKED_TO_BUILDING_BLOCK = 'linked to a building-block secret';

export interface VarWriteResult {
  /** The new `applications.env`, the source of truth. */
  env: ApplicationEnvVar[];
  /** Keys refused, with the reason — surfaced by the caller, never silent. */
  skipped: Array<{ name: string; reason: string }>;
}

const indexOf = (env: ApplicationEnvVar[]) =>
  new Map(env.map((e, i) => [e.name, i]));

/**
 * Apply a plain-variable payload to `applications.env`.
 *
 * The DB row is the source of truth; the ConfigMap is rendered from it. Writing
 * here — rather than straight to the ConfigMap — is what makes an edit survive
 * the next deploy, which regenerates that ConfigMap from this list.
 *
 * Two classes of key are refused rather than overwritten:
 *   - `externalSecretRef` (a catalog building block's Secret): a plain value
 *     would swap a `secretKeyRef` for cleartext in the DB and break the link.
 *   - `secret: true`: a sensitive var arriving through the plain path would be
 *     rendered into the ConfigMap in cleartext. It must go through
 *     {@link applySensitiveVars}.
 *
 * Deletion is explicit (`deleteKeys`), never inferred from absence — a payload
 * built from a partial or stale read must not be able to erase stored config.
 */
export function applyPlainVars(
  existing: ApplicationEnvVar[],
  data: Record<string, string>,
  deleteKeys: string[] = [],
): VarWriteResult {
  const env = [...existing];
  const skipped: VarWriteResult['skipped'] = [];
  const at = indexOf(env);

  for (const [name, value] of Object.entries(data)) {
    const i = at.get(name);
    const prev = i === undefined ? undefined : env[i];

    if (prev?.externalSecretRef) {
      skipped.push({ name, reason: LINKED_TO_BUILDING_BLOCK });
      continue;
    }
    if (prev?.secret) {
      skipped.push({ name, reason: 'is a sensitive variable' });
      continue;
    }

    const next: ApplicationEnvVar = { name, value, source: 'user' };
    if (i === undefined) {
      at.set(name, env.length);
      env.push(next);
    } else {
      env[i] = next;
    }
  }

  return { env: applyDeletes(env, deleteKeys, (e) => !e.secret), skipped };
}

/**
 * Apply a sensitive-variable payload to `applications.env`, encrypting each
 * value at rest exactly as the PATCH path does — the manifest generator
 * decrypts on its way into the Kubernetes Secret.
 *
 * Keys linked to an external Secret are refused (same reasoning as
 * {@link applyPlainVars}), and a masked value is dropped: it means the editor
 * sent back a placeholder for a secret the user never retyped.
 */
export function applySensitiveVars(
  existing: ApplicationEnvVar[],
  data: Record<string, string>,
  deleteKeys: string[] = [],
  encrypt: (value: string) => string = (v) => v,
): VarWriteResult {
  const env = [...existing];
  const skipped: VarWriteResult['skipped'] = [];
  const at = indexOf(env);

  for (const [name, value] of Object.entries(data)) {
    const i = at.get(name);
    const prev = i === undefined ? undefined : env[i];

    if (prev?.externalSecretRef) {
      skipped.push({ name, reason: LINKED_TO_BUILDING_BLOCK });
      continue;
    }
    if (SECRET_MASKS.has(value)) {
      skipped.push({ name, reason: 'value is the display mask, not a secret' });
      continue;
    }

    const next: ApplicationEnvVar = {
      name,
      value: encrypt(value),
      secret: true,
      source: 'user',
    };
    if (i === undefined) {
      at.set(name, env.length);
      env.push(next);
    } else {
      env[i] = next;
    }
  }

  return { env: applyDeletes(env, deleteKeys, (e) => !!e.secret), skipped };
}

/**
 * Remove the requested keys, but only the ones this section owns — a plain save
 * must not be able to delete a secret, and neither may drop a building-block
 * link, which is owned by the catalog wiring rather than by this editor.
 */
function applyDeletes(
  env: ApplicationEnvVar[],
  deleteKeys: string[],
  owns: (e: ApplicationEnvVar) => boolean,
): ApplicationEnvVar[] {
  if (deleteKeys.length === 0) return env;
  const doomed = new Set(deleteKeys);
  return env.filter(
    (e) => !doomed.has(e.name) || !!e.externalSecretRef || !owns(e),
  );
}

/** The plain (ConfigMap-bound) projection of the source of truth. */
export function plainEnvData(env: ApplicationEnvVar[]): Record<string, string> {
  return Object.fromEntries(
    env
      .filter((e) => !e.secret && !e.externalSecretRef && !e.pending)
      .map((e) => [e.name, e.value ?? '']),
  );
}

/**
 * Declare sensitive keys as awaiting a value, without carrying one.
 *
 * This is the half of the hand-off an agent may perform: it names the key and
 * stops. The entry is written to `applications.env` with an empty value and
 * `pending: true`, so the missing value is a durable, declared state rather
 * than something inferred later from an absence.
 *
 * Refusals are deliberate and each is a state, not a failure:
 *   - a key already carrying a value is left alone. Clearing a working
 *     credential is a destructive act, and an agent asking for "the API key"
 *     of an app that already has one must not be able to wipe it;
 *   - a key linked to a building block's Secret has no value of ours to wait for;
 *   - a plain key of the same name would change type behind the editor's back.
 */
export function requestSensitiveVars(
  existing: ApplicationEnvVar[],
  keys: string[],
): VarWriteResult {
  const env = [...existing];
  const skipped: VarWriteResult['skipped'] = [];
  const at = indexOf(env);

  for (const name of keys) {
    const i = at.get(name);
    const prev = i === undefined ? undefined : env[i];

    if (prev?.externalSecretRef) {
      skipped.push({ name, reason: LINKED_TO_BUILDING_BLOCK });
      continue;
    }
    if (prev && !prev.secret) {
      skipped.push({ name, reason: 'already exists as a plain variable' });
      continue;
    }
    if (prev?.secret && !prev.pending && prev.value) {
      skipped.push({ name, reason: 'already configured' });
      continue;
    }

    const next: ApplicationEnvVar = {
      name,
      value: '',
      secret: true,
      pending: true,
      source: 'user',
    };
    if (i === undefined) {
      at.set(name, env.length);
      env.push(next);
    } else {
      env[i] = next;
    }
  }

  return { env, skipped };
}

/** The keys still waiting for a person — the "missing a value" state, read back. */
export function pendingEnvKeys(env: ApplicationEnvVar[]): string[] {
  return env.filter((e) => e.pending).map((e) => e.name);
}

/**
 * The entries a deploy may render. A pending key is deliberately absent from
 * both the Secret and the container's env: see {@link ApplicationEnvVar.pending}.
 */
export function renderableEnv(
  env: ApplicationEnvVar[] | undefined | null,
): ApplicationEnvVar[] {
  return (env ?? []).filter((e) => !e.pending);
}
