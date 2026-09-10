/**
 * The manifest, flattened into the two fact objects the repository family
 * compares against.
 *
 * `manifest-repo-checks.core.ts` deliberately never imports the manifest
 * interface — a pure comparison module that knows the manifest shape starts
 * answering questions about manifest shape. This is the seam that keeps it
 * that way: everything that has to know what `deploy.env` looks like, or which
 * fields this installation quietly ignores, is read here, once, and handed
 * over as already-read facts.
 *
 * Two rules, and they are why this file is separate rather than inlined in the
 * deploy service:
 *
 * 1. **Nothing is inferred about the cluster or the repository.** Only what the
 *    manifest itself says.
 * 2. **A field is only called inert when nothing in this installation reads
 *    it.** Each entry below was checked against the code, not taken from the
 *    schema's own marker.
 */

import type { ApplicationManifest } from '@flui-cloud/spec';
import {
  manifestDeclaredEnvNames,
  normalizeManifestEnv,
} from './utils/manifest-env.util';
import type {
  ManifestClaims,
  ManifestSelfFacts,
  ManifestShapeFacts,
} from './manifest-repo-checks.core';

/**
 * The same normalisation the build applies (`resolveBuildPaths`), so a claim
 * derived here and a path compared there can never disagree.
 */
function normalizePath(p: string): string {
  const body = p.startsWith('./') ? p.slice(2) : p;
  let start = 0;
  while (start < body.length && body[start] === '/') start += 1;
  let end = body.length;
  while (end > start && body[end - 1] === '/') end -= 1;
  const v = body.slice(start, end);
  return v === '' ? '.' : v;
}

/** The directory this manifest builds, or null for the whole repository. */
function unitPathOf(manifest: ApplicationManifest): string | null {
  const context = normalizePath(manifest.build?.context ?? '.');
  if (context !== '.') return context;
  const dockerfile = manifest.build?.dockerfile
    ? normalizePath(manifest.build.dockerfile)
    : null;
  if (!dockerfile?.includes('/')) return null;
  return dockerfile.slice(0, dockerfile.lastIndexOf('/'));
}

/**
 * What an env entry points at instead of carrying a value.
 *
 * `valueFrom.service` names another Flui application, not an engine, so the
 * name is offered whole *and* split on its separators: a repository that
 * declares `postgres` is answered by a manifest linking `orders-postgres`,
 * and the alternative — matching only the whole name — turns every sensibly
 * named link into a warning about a service the deploy will in fact provide.
 * Erring toward silence is the rule of this family.
 */
function serviceKindsFrom(ref: string): string[] {
  const name = ref.trim().toLowerCase();
  if (!name) return [];
  const parts = name.split(/[-_.]/).filter((p) => p.length > 1);
  return [name, ...parts];
}

interface ManifestAttachedServiceEnv {
  name: string;
  fromService?: string;
}

interface ManifestAttachedService {
  name?: string;
  block?: string;
  env?: ManifestAttachedServiceEnv[];
}

/**
 * `deploy.services` — a building block attached to this application
 * (`{name, block, env: [{name, fromService}]}`) — read past the type system
 * the same way `deploy.env`'s map form is (`manifest-env.util.ts`): the
 * installed spec type does not declare the field, but ajv has already accepted
 * whichever shape this manifest passed validation with before we get here.
 */
function attachedServicesFrom(
  manifest: ApplicationManifest,
): ManifestAttachedService[] {
  const services = (manifest.deploy as unknown as { services?: unknown })
    .services;
  return Array.isArray(services) ? (services as ManifestAttachedService[]) : [];
}

/**
 * `deploy.services[].block` names the catalog ref used to install
 * (`postgresql`, `pgvector`, …); the repository side compares against the
 * engine it detects (`postgres`, …) — `repo-facts.core.ts`'s own doc: "the
 * engine is what a manifest can be compared against". Every ref under
 * `src/modules/catalog/seed/*.flui.yaml` whose `metadata.id` differs from its
 * `spec.engine`, read from all fourteen seeds, not a table built around one
 * repository.
 */
const BLOCK_ENGINE_ALIASES: Readonly<Record<string, string>> = {
  postgresql: 'postgres',
  pgvector: 'postgres',
};

function serviceKindsFromBlock(block: string): string[] {
  const kinds = serviceKindsFrom(block);
  const alias = BLOCK_ENGINE_ALIASES[block.trim().toLowerCase()];
  return alias ? [...kinds, alias] : kinds;
}

export function manifestClaims(manifest: ApplicationManifest): ManifestClaims {
  const entries = normalizeManifestEnv(manifest.deploy?.env);
  const attachedServices = attachedServicesFrom(manifest);
  const providedServiceKinds = [
    ...entries.flatMap((e) =>
      e.valueFrom?.service ? serviceKindsFrom(e.valueFrom.service) : [],
    ),
    ...attachedServices.flatMap((s) => [
      ...(s.block ? serviceKindsFromBlock(s.block) : []),
      ...(s.name ? serviceKindsFrom(s.name) : []),
    ]),
  ];
  const attachedServiceEnvKeys = attachedServices.flatMap((s) =>
    (s.env ?? []).filter((e) => e.fromService).map((e) => e.name),
  );
  // A key an environment profile sets on some branch is supplied, not missing:
  // the overlay for the branch being validated is already merged into
  // `deploy.env` by the time this runs, and warning about the others would be
  // warning about a value the deploy does set, on the branch that has it.
  const profileKeys = Object.values(manifest.environments ?? {}).flatMap((p) =>
    Object.keys(p?.env ?? {}),
  );

  return {
    dockerfilePath: manifest.build?.dockerfile ?? null,
    buildContext: manifest.build?.context ?? null,
    buildStrategy: manifest.build?.strategy ?? null,
    port: manifest.deploy?.port ?? null,
    healthPath: manifest.deploy?.healthcheck?.path ?? null,
    declaredEnvKeys: manifestDeclaredEnvNames(manifest.deploy?.env),
    suppliedEnvKeys: [...profileKeys, ...attachedServiceEnvKeys],
    providedServiceKinds,
    unitPath: unitPathOf(manifest),
  };
}

/**
 * Fields present in the manifest that this installation reads and then does
 * nothing with. Each one verified against the code rather than against the
 * schema's marker:
 *
 * - `deploy.resources.profile` — no reader anywhere in `src/`.
 * - `deploy.scaling` — the deploy creates the application without it, so the
 *   app runs at one replica whatever the block says. Its one reader is this
 *   validation's own capacity estimate (`readCapacity` multiplies by
 *   `scaling.min`), which is a figure in a check and never a replica count.
 * - `deploy.env[].userEditable` — read by the catalog install path, never by
 *   the Application deploy path this manifest travels.
 * - `deploy.env[].delivery` — carried through `deploy.env` verbatim and applied
 *   by nothing.
 */
function inertFieldsOf(manifest: ApplicationManifest): string[] {
  const inert: string[] = [];
  if (manifest.deploy?.resources?.profile !== undefined) {
    inert.push('deploy.resources.profile');
  }
  if (manifest.deploy?.scaling !== undefined) {
    inert.push('deploy.scaling');
  }
  const entries = normalizeManifestEnv(manifest.deploy?.env);
  if (entries.some((e) => e.userEditable !== undefined)) {
    inert.push('deploy.env[].userEditable');
  }
  if (
    entries.some((e) => (e as { delivery?: unknown }).delivery !== undefined)
  ) {
    inert.push('deploy.env[].delivery');
  }
  return inert;
}

export function manifestShapeFacts(
  manifest: ApplicationManifest,
): ManifestShapeFacts {
  const env = manifest.deploy?.env;
  let envForm: ManifestShapeFacts['envForm'] = 'absent';
  if (Array.isArray(env)) envForm = 'list';
  else if (env && typeof env === 'object') envForm = 'map';

  return {
    apiVersion: manifest.apiVersion,
    envForm,
    inertFields: inertFieldsOf(manifest),
    resolvedBuildStrategy: manifest.build?.strategy ?? null,
  };
}

export function manifestSelfFacts(
  manifest: ApplicationManifest,
): ManifestSelfFacts {
  return {
    claims: manifestClaims(manifest),
    currency: manifestShapeFacts(manifest),
  };
}
