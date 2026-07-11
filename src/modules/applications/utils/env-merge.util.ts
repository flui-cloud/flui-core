import { ApplicationEnvVar } from '../interfaces/source-config.interface';

/**
 * Merge the flui.yaml env over what's already stored. A manifest deploy is
 * authoritative ONLY over `manifest` keys; `user` (--env / dashboard) and `link`
 * (catalog building-block refs) entries persist and are never clobbered — a value
 * the user set after a deploy must survive every subsequent deploy.
 *
 * Legacy untagged entries are adopted by the manifest only when they're a plain
 * value whose name the manifest declares, so an untagged link/secret is never
 * silently disconnected.
 */
export function mergeAppEnv(
  existing: ApplicationEnvVar[],
  manifestEnv: ApplicationEnvVar[],
  overrides?: Record<string, string>,
): ApplicationEnvVar[] {
  const manifestNames = new Set(manifestEnv.map((e) => e.name));
  const result = new Map<string, ApplicationEnvVar>();

  for (const e of existing) {
    if (e.source === 'manifest') continue;
    const legacyPlain =
      e.source === undefined && !e.externalSecretRef && !e.secret;
    if (legacyPlain && manifestNames.has(e.name)) continue;
    result.set(e.name, e);
  }
  // Manifest owns its keys but yields to a preserved user/link value of the same name.
  for (const m of manifestEnv) {
    if (result.has(m.name)) continue;
    result.set(m.name, m);
  }
  // --env overrides are explicit user intent: upsert as user, persist across deploys.
  for (const [name, value] of Object.entries(overrides ?? {})) {
    result.set(name, { name, value, source: 'user' });
  }
  return [...result.values()];
}
