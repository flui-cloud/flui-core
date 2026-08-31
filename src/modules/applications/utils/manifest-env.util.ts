import {
  ApplicationManifest,
  ApplicationManifestEnvVar,
} from '@flui-cloud/spec';
import { ApplicationEnvVar } from '../interfaces/source-config.interface';

/**
 * Normalize `deploy.env` from either wire form into the array shape the deploy
 * pipeline consumes. Two forms are accepted (see `@flui-cloud/spec` 0.8.0):
 *
 *   - list (legacy):   [{ name, value?, valueFrom?, secret? }, …]
 *   - map (preferred): { NAME: "value" | { value?, valueFrom?, secret?, … } }
 *
 * A bare string in the map is shorthand for `{ value: … }`. The map key is the
 * env name and always wins over a `name` nested in the entry. Fields the
 * runtime does not yet apply (`delivery`, `valueFrom.service`) are carried
 * through untouched — `manifestEnvVar` simply ignores what it doesn't read.
 *
 * Typed `unknown` on purpose: the installed spec type still describes the list
 * form only, so the map arrives past the type system; validation (ajv) has
 * already accepted whichever form this is before we get here.
 */
export function normalizeManifestEnv(
  env: unknown,
): ApplicationManifestEnvVar[] {
  if (env == null) return [];
  if (Array.isArray(env)) return env as ApplicationManifestEnvVar[];
  if (typeof env !== 'object') return [];

  return Object.entries(env as Record<string, unknown>).map(([name, spec]) => {
    if (typeof spec === 'string') return { name, value: spec };
    if (spec && typeof spec === 'object') {
      return {
        ...(spec as Record<string, unknown>),
        name,
      } as ApplicationManifestEnvVar;
    }
    return { name };
  });
}

/**
 * Every env key the manifest declares — including the ones that resolve to no
 * value (`valueFrom.userInput`, an unresolvable `valueFrom.service`, a malformed
 * `secretRef`) and so never reach the resolved env list. `mergeAppEnv` needs
 * this to tell "the manifest dropped this key" (remove it) apart from "the
 * manifest declares it but sources the value elsewhere" (keep what is stored).
 */
export function manifestDeclaredEnvNames(env: unknown): string[] {
  return normalizeManifestEnv(env).map((e) => e.name);
}

/**
 * Overlay the environment profile bound to `branch` onto the base manifest. The
 * `environments` block binds a git branch to a set of overrides: a push on that
 * branch deploys with those values. Only the whitelisted deploy fields
 * (resources, scaling, domain) and literal env values are overridden — `build`
 * is never per-environment (the same image is promoted across environments), and
 * a key's delivery / valueFrom stay as declared once on the base `deploy.env`.
 *
 * Returns the manifest unchanged when there is no `environments` block, no
 * branch, or no profile bound to this branch.
 */
export function applyEnvironmentProfile(
  manifest: ApplicationManifest,
  branch?: string,
): ApplicationManifest {
  const environments = manifest.environments;
  if (!environments || !branch) return manifest;
  const profile = Object.values(environments).find((p) => p.branch === branch);
  if (!profile) return manifest;

  const overlaid = new Map(
    normalizeManifestEnv(manifest.deploy.env).map((e) => [e.name, e]),
  );
  for (const [name, value] of Object.entries(profile.env ?? {})) {
    overlaid.set(name, { name, value });
  }

  return {
    ...manifest,
    deploy: {
      ...manifest.deploy,
      env: [...overlaid.values()],
      resources: profile.deploy?.resources ?? manifest.deploy.resources,
      scaling: profile.deploy?.scaling ?? manifest.deploy.scaling,
      domain: profile.deploy?.domain ?? manifest.deploy.domain,
    },
  };
}

export type ServiceRefKey = 'url' | 'host' | 'port';

export interface ServiceRef {
  /** Slug of the referenced sibling app. */
  service: string;
  /** Which attribute to inject; defaults to the full URL. */
  key: ServiceRefKey;
}

/** The referenced sibling's in-cluster coordinates. */
export interface ServiceRefTarget {
  slug: string;
  namespace: string;
  port?: number | null;
}

/** A `valueFrom.service` reference, or null for any other entry. */
export function readServiceRef(
  e: ApplicationManifestEnvVar,
): ServiceRef | null {
  const service = e.valueFrom?.service;
  if (typeof service !== 'string' || service.length === 0) return null;
  return { service, key: e.valueFrom?.key ?? 'url' };
}

/**
 * Resolve a `valueFrom.service` reference to the sibling's in-cluster address —
 * the same Kubernetes Service DNS Flui already uses to wire catalog building
 * blocks into their dependents (`<slug>-svc.<namespace>.svc.cluster.local`).
 * App-to-app traffic stays inside the cluster; it never round-trips the public
 * ingress. A public URL is intentionally NOT used here.
 */
export function serviceRefValue(
  target: ServiceRefTarget,
  key: ServiceRefKey = 'url',
): string {
  const host = `${target.slug}-svc.${target.namespace}.svc.cluster.local`;
  if (key === 'host') return host;
  if (key === 'port') return target.port != null ? String(target.port) : '';
  return target.port != null
    ? `http://${host}:${target.port}`
    : `http://${host}`;
}

/** A flui.yaml discovered in a repo at a ref (subset of the manifests DTO). */
export interface ManifestCandidate {
  valid: boolean;
  content?: string;
  name?: string;
  path: string;
}

/**
 * Choose the manifest that belongs to an app among those discovered in its repo
 * at a commit. Prefer an exact `metadata.name` match (robust in a monorepo);
 * then the manifest whose directory matches the app's build subPath; then the
 * sole manifest if there is exactly one. Null when nothing plausibly matches —
 * the caller then keeps the existing env rather than guessing.
 */
export function pickAppManifest(
  manifests: ManifestCandidate[],
  appName: string,
  subPath?: string,
): ManifestCandidate | null {
  const valid = manifests.filter((m) => m.valid && !!m.content);
  const dir = (p: string) => {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  };
  return (
    valid.find((m) => m.name === appName) ??
    valid.find((m) => dir(m.path) === (subPath ?? '')) ??
    (valid.length === 1 ? valid[0] : null)
  );
}

/** The scope a `valueFrom.service` reference is resolved within. */
export interface ServiceRefScope {
  clusterId: string;
  projectId?: string | null;
}

/** A sibling app as seen by service-ref resolution. */
export interface ServiceRefSibling extends ServiceRefTarget {
  clusterId: string;
  projectId?: string | null;
  deleted?: boolean;
}

export type ServiceRefSkipReason =
  | 'not-found'
  | 'cross-cluster'
  | 'cross-project';

export interface ServiceRefResolution {
  /** The resolved in-cluster value, or null when the reference is unresolvable. */
  value: string | null;
  /** Why the reference was skipped; present only when `value` is null. */
  reason?: ServiceRefSkipReason;
}

/**
 * Decide what a `valueFrom.service` reference resolves to, given the candidate
 * sibling (looked up by slug elsewhere). Pure: the caller does the I/O and the
 * logging. A reference resolves only to a sibling that is live, on the same
 * cluster (so its in-cluster DNS is reachable) and — when both apps are
 * assigned to one — in the same project.
 *
 * Returns `{ reason }` (no discriminant) rather than a tagged union: this repo
 * builds with `strictNullChecks` off, where boolean-tagged unions do not narrow.
 */
export function resolveServiceRefAgainst(
  ref: ServiceRef,
  scope: ServiceRefScope,
  sibling: ServiceRefSibling | null,
): ServiceRefResolution {
  if (!sibling || sibling.deleted) return { value: null, reason: 'not-found' };
  if (sibling.clusterId !== scope.clusterId) {
    return { value: null, reason: 'cross-cluster' };
  }
  if (
    scope.projectId &&
    sibling.projectId &&
    sibling.projectId !== scope.projectId
  ) {
    return { value: null, reason: 'cross-project' };
  }
  return { value: serviceRefValue(sibling, ref.key) };
}

export interface SeedUserInputDefaultsResult {
  /** `existing`, plus a seeded `user` entry for every default-carrying key that had none. */
  existing: ApplicationEnvVar[];
  /**
   * Keys with `valueFrom.userInput` that have neither a stored value nor a
   * manifest `default` — the deploy proceeds, but this var reaches the
   * container empty (or absent) until someone sets it.
   */
  missingRequired: string[];
}

/**
 * `valueFrom.userInput` never resolves to a manifest value (see
 * `manifestEnvVar`) — the deployer's own value, once set via the variables
 * endpoint or `--env`, is a `user`-sourced entry the manifest never declares
 * as resolved, so `mergeAppEnv` preserves it across every future deploy. This
 * seeds that same `user` entry from `valueFrom.userInput.default`, but ONLY
 * the first time — once anything exists at that name, seeding is a no-op, so
 * a person's later edit is never overwritten by the manifest's default on the
 * next redeploy. A key with neither a stored value nor a default is named in
 * `missingRequired` so the deploy can warn instead of shipping it silently.
 */
export function seedUserInputDefaults(
  env: ApplicationManifestEnvVar[],
  existing: ApplicationEnvVar[],
): SeedUserInputDefaultsResult {
  const known = new Set(existing.map((e) => e.name));
  const seeded: ApplicationEnvVar[] = [];
  const missingRequired: string[] = [];

  for (const e of env) {
    const prompt = e.valueFrom?.userInput;
    if (!prompt || known.has(e.name)) continue;
    if (prompt.default !== undefined) {
      seeded.push({
        name: e.name,
        value: prompt.default,
        source: 'user',
        ...(prompt.sensitive ? { secret: true } : {}),
      });
    } else {
      missingRequired.push(e.name);
    }
  }

  return {
    existing: seeded.length ? [...existing, ...seeded] : existing,
    missingRequired,
  };
}
