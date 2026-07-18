import { ApplicationEnvVar } from '../interfaces/source-config.interface';

/**
 * Merge the flui.yaml env over what's already stored, with git (the manifest)
 * as the source of truth for the keys it declares.
 *
 * Precedence, lowest to highest:
 *   1. existing `user`/`link` entries the manifest does NOT declare — preserved
 *   2. the manifest — authoritative for every key it declares (reclaims the key
 *      even if a `user` value was pinned on it; that pin is shadowed, see
 *      `collectEnvShadows`)
 *   3. explicit `--env` / `--env-file` overrides — deliberate, win every collision
 *
 * Exception: a linked secret (`externalSecretRef`, e.g. a catalog building
 * block's K8s Secret) is NEVER clobbered by a plain manifest value — that would
 * swap a `secretKeyRef` for a plaintext value in the DB and leak a credential.
 *
 * This inverts the previous rule (a `user` pin used to beat the manifest
 * forever, invisibly and irreversibly). Now the manifest reclaims its keys, and
 * a pin only survives on a key the manifest does not declare.
 *
 * `declaredNames` carries every key the manifest DECLARES, including those that
 * resolve to no value (`valueFrom.userInput`, an unresolvable `valueFrom.service`,
 * a malformed `secretRef`) and are therefore absent from `manifestEnv`. The two
 * lists differ, and the difference matters: a declared-but-unresolved key means
 * "this var exists, its value comes from outside the manifest" — the stored
 * value must survive. Only a key the manifest no longer declares at all is a
 * deliberate removal. Omit the argument and declared collapses to resolved,
 * which is the pre-existing behaviour.
 */
export function mergeAppEnv(
  existing: ApplicationEnvVar[],
  manifestEnv: ApplicationEnvVar[],
  overrides?: Record<string, string>,
  declaredNames?: Iterable<string>,
): ApplicationEnvVar[] {
  const manifestByName = new Map(manifestEnv.map((m) => [m.name, m]));
  const declared = declaredNames
    ? new Set(declaredNames)
    : new Set(manifestByName.keys());
  const result = new Map<string, ApplicationEnvVar>();

  // 1. Existing entries the manifest does NOT reclaim: user/link keys absent
  //    from the manifest, and linked secrets (kept even when the manifest names
  //    them, so a plain value can't overwrite a secretKeyRef).
  for (const e of existing) {
    const resolved = manifestByName.has(e.name);
    const isLinkedSecret = !!e.externalSecretRef;
    if (resolved && !isLinkedSecret) continue; // manifest reclaims it below
    // A manifest-owned key the manifest stopped declaring is a removal. One it
    // still declares without a value keeps the value stored here.
    if (e.source === 'manifest' && !declared.has(e.name)) continue;
    result.set(e.name, e);
  }

  // 2. Manifest owns the keys it declares — unless a linked secret above kept it.
  for (const m of manifestEnv) {
    if (result.get(m.name)?.externalSecretRef) continue;
    result.set(m.name, m);
  }

  // 3. --env overrides are explicit user intent: upsert as user, win every collision.
  for (const [name, value] of Object.entries(overrides ?? {})) {
    result.set(name, { name, value, source: 'user' });
  }

  return [...result.values()];
}

/** A `user` pin overwritten by the manifest on this deploy — surfaced so the reclaim is never silent. */
export interface EnvShadow {
  name: string;
  /** The pinned user value being overwritten. */
  previous: string;
  /** The manifest value taking over. */
  manifest: string;
}

/**
 * Detect keys where the manifest is about to overwrite a differing `user` pin —
 * the visibility half of the reclaim rule. An explicit `--env` override on the
 * same key re-asserts the user value and is not a shadow; linked secrets are
 * never shadowed (they are preserved by {@link mergeAppEnv}).
 */
export function collectEnvShadows(
  existing: ApplicationEnvVar[],
  manifestEnv: ApplicationEnvVar[],
  overrides?: Record<string, string>,
): EnvShadow[] {
  const manifestByName = new Map(manifestEnv.map((m) => [m.name, m]));
  const overrideNames = new Set(Object.keys(overrides ?? {}));
  const shadows: EnvShadow[] = [];
  for (const e of existing) {
    if (e.source !== 'user' || e.externalSecretRef) continue;
    if (overrideNames.has(e.name)) continue; // --env re-asserts the value
    const m = manifestByName.get(e.name);
    if (m && !m.externalSecretRef && m.value !== e.value) {
      shadows.push({ name: e.name, previous: e.value, manifest: m.value });
    }
  }
  return shadows;
}
