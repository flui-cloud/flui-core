import {
  ApplicationManifest,
  ApplicationManifestDomain,
} from '@flui-cloud/spec';

/**
 * Install-time overrides of manifest fields, stored on the application so they
 * survive every later manifest deploy.
 *
 * The manifest stays the source of truth for everything the repo owns (build,
 * port, resources, env defaults). These are the few fields that belong to the
 * *installation* rather than to the code: the same repo deployed twice needs a
 * different name and a different domain, and neither can live in a file that
 * both installs share.
 *
 * Provenance mirrors env vars (see env-merge.util): an explicit override wins
 * over the manifest, and keeps winning on later deploys — otherwise the next
 * `flui deploy` from anyone's machine would silently revert an install to the
 * manifest's domain.
 */
export interface DeployOverrides {
  /**
   * Release name. Identity-forming — it is part of the app key
   * (cluster, repository, branch, name) — so it is never read back from
   * storage: pass it on every deploy that targets that install.
   */
  name?: string;
  exposure?: 'public' | 'internal';
  domain?: ApplicationManifestDomain;
}

export const DEPLOY_OVERRIDES_METADATA_KEY = 'flui.deploy.overrides';

const isDefined = <T>(v: T | undefined | null): v is T =>
  v !== undefined && v !== null;

/** Drops undefined entries so a partial override never blanks a stored value. */
function compact<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => isDefined(v)),
  ) as Partial<T>;
}

export function hasDeployOverrides(o?: DeployOverrides | null): boolean {
  if (!o) return false;
  return (
    isDefined(o.name) ||
    isDefined(o.exposure) ||
    (isDefined(o.domain) && Object.keys(compact(o.domain)).length > 0)
  );
}

/**
 * Merges the overrides stored on the app with the ones passed on this deploy.
 * Incoming wins field by field; `domain` merges per key so `--domain` alone
 * does not drop a previously chosen cert challenge.
 */
export function mergeDeployOverrides(
  stored: DeployOverrides | null | undefined,
  incoming: DeployOverrides | null | undefined,
): DeployOverrides {
  const merged: DeployOverrides = {
    ...compact(stored ?? {}),
    ...compact(incoming ?? {}),
  };
  const domain = {
    ...compact(stored?.domain ?? {}),
    ...compact(incoming?.domain ?? {}),
  };
  if (Object.keys(domain).length > 0) merged.domain = domain;
  else delete merged.domain;
  return merged;
}

/**
 * Returns a copy of the manifest with the overrides applied. Pure — the caller
 * keeps the parsed manifest untouched for diffing/logging.
 */
export function applyDeployOverrides(
  manifest: ApplicationManifest,
  overrides?: DeployOverrides | null,
): ApplicationManifest {
  if (!hasDeployOverrides(overrides) || !overrides) return manifest;

  const next: ApplicationManifest = {
    ...manifest,
    metadata: { ...manifest.metadata },
    deploy: { ...manifest.deploy },
  };

  if (isDefined(overrides.name)) next.metadata.name = overrides.name;
  if (isDefined(overrides.exposure)) next.deploy.exposure = overrides.exposure;

  const domain = compact(overrides.domain ?? {});
  if (Object.keys(domain).length > 0) {
    next.deploy.domain = { ...manifest.deploy.domain, ...domain };
  }

  return next;
}

/**
 * Manifest values an override is masking, for a warning at deploy time. Silent
 * shadowing is the trap this whole model exists to avoid: the operator must be
 * able to see why the repo says one thing and the cluster does another.
 */
export function collectOverrideShadows(
  manifest: ApplicationManifest,
  overrides?: DeployOverrides | null,
): string[] {
  if (!hasDeployOverrides(overrides) || !overrides) return [];
  const shadows: string[] = [];

  if (isDefined(overrides.name) && manifest.metadata.name !== overrides.name) {
    shadows.push(
      `metadata.name "${manifest.metadata.name}" -> "${overrides.name}"`,
    );
  }
  if (
    isDefined(overrides.exposure) &&
    isDefined(manifest.deploy.exposure) &&
    manifest.deploy.exposure !== overrides.exposure
  ) {
    shadows.push(
      `deploy.exposure "${manifest.deploy.exposure}" -> "${overrides.exposure}"`,
    );
  }
  for (const [key, value] of Object.entries(compact(overrides.domain ?? {}))) {
    const current =
      manifest.deploy.domain?.[key as keyof ApplicationManifestDomain];
    if (isDefined(current) && current !== value) {
      shadows.push(`deploy.domain.${key} "${current}" -> "${value}"`);
    }
  }

  return shadows;
}

/** Reads the overrides persisted on an application, tolerating legacy/absent metadata. */
export function readStoredOverrides(
  metadata: Record<string, any> | null | undefined,
): DeployOverrides | null {
  const raw = metadata?.[DEPLOY_OVERRIDES_METADATA_KEY];
  if (!raw) return null;
  if (typeof raw === 'object') return raw as DeployOverrides;
  try {
    return JSON.parse(String(raw)) as DeployOverrides;
  } catch {
    return null;
  }
}
